---
description: >-
  The `config_entries` table: every tunable setting the engine persists, with its UI metadata.
---

# The config_entries table

## `config_entries`

Engine configuration registry - each tunable setting with UI metadata.
Read by `GET /config`, written by `POST /config`.
Struct is `db::ConfigEntry`.

| Column          | Type    | Notes                                                  |
|-----------------|---------|--------------------------------------------------------|
| `key`           | TEXT PK | e.g. `workers`, `dbCacheSize`, `liveTickIntervalMs` |
| `value`         | TEXT    | Current value (parsed per `type`)                      |
| `type`          | TEXT    | `"integer"` / `"string"` / `"boolean"` / `"number"` / `"enum"` |
| `label`         | TEXT    | Display label                                          |
| `description`   | TEXT    | Help text                                              |
| `category`      | TEXT    | Which sidebar row it renders under; one of `general_engine`, `network_performance`, `services`, `observability`, `data_retention`, `limits`, `scripting_sandbox` |
| `default_value` | TEXT    | Default as string                                      |
| `min_value`     | TEXT    | Optional minimum (numbers)                             |
| `max_value`     | TEXT    | Optional maximum (numbers)                             |
| `options`       | TEXT    | JSON array of `{value, label}`; `"enum"` entries only  |
| `updated_at`    | INTEGER | Unix ms                                                |
| `requires_restart` | INTEGER | Boolean; the running engine keeps the old value until restarted |
| `advanced`      | INTEGER | Boolean; an internal, rendered collapsed under "Advanced" |
| `keywords`      | TEXT    | JSON array of extra search terms; `"[]"` when the entry declares none |
| `unit`          | TEXT    | What a numeric value measures (`ms`, `sec`, `days`, `bytes`); NULL for a count |
| `depends_on`    | TEXT    | Key of a boolean entry in the same category this one means nothing without; NULL when the entry stands on its own |

**A row can outlive the catalogue that wrote it** (issue #1492).
`seed_default_config` only touches two lists on every start - the keys it upserts and a fixed retired-key list it deletes - so a row for a key neither list names (a workspace a *newer* engine opened, then reopened by this one) is left untouched: still on disk, still readable by `get_config_entry`, but not one this build's `seed_default_config` declared.
`GET /config` and a successful `POST /config`'s echoed `entries` both filter to `Database::is_known_config_key`, the set `seed_default_config` populated on this start, rather than to "every row in the table" - so neither ever describes a setting this build has no label, no validator and no bounds for.
`POST /config` refuses a write to such a key the same way it refuses a key with no row at all: "Unknown config key", `invalid_config`.
`is_known_config_key` answers from that populated set, never from whether a row exists - a row existing is exactly the case this guards.

**category** is a closed set, and it is the app that closes it: the renderer draws one sidebar row per category it declares (`app/src/modules/settings/engine-categories.ts`) and drops an entry whose category it does not know, so a value outside the list above is a setting with no screen.
`seed_default_config` is the only writer, and two guards pin the two lists against each other from opposite sides:
`ConfigRouteTest.EverySeededEntrySitsInADeclaredCategory` reads the seeded rows against a set copied into the C++ test, and `engine-categories.test.ts` reads the seven `engine/src/db/config_seeds/*.cpp` files (#1611) against the renderer's registry - so a category added to the seed and to the C++ set but forgotten in the app still fails.
Reseeding rewrites an existing row's metadata while keeping its value, which is how a retired category (`database_performance`, folded into `general_engine` in #586) carries an upgraded database across with nothing to migrate by hand.

**depends_on** (issue #1610) names a relation, never a value: `correlationIdHeader` carries `depends_on: "correlationIdEnabled"`, since the header means nothing until the id is switched on.
`ConfigSeeder::validate_dependencies`, called once every category's seed function has run, refuses a `depends_on` naming a key nothing seeded, a key in a different category, or a key that is not itself `"boolean"` - the same refusal shape as a key seeded twice.
`GET /config` serializes it as `dependsOn`, omitted when absent; `POST /config` never reads it back, because it describes the catalogue, not a stored value.
The settings screen (`SettingsMain.tsx`) nests the dependent's card immediately beneath its parent's, indented and disabled until the parent reads `true`.

**The seed itself is one file per category** (issue #1611):
`Database::seed_default_config` (`engine/src/db/db_config.cpp`) is the ordered list of seven calls, one per `engine/src/db/config_seeds/{general, network, services, observability, data_retention, limits, scripting}.cpp` - each file holding exactly the `ConfigEntry` literals for the category its name says, over the shared `ConfigSeeder` and helpers in `config_seeds/seed.hpp`.
Adding a setting is editing the one category file it belongs to; adding a category is one new file and one call.

**A stored value is the user's, except where an entry opts in to follow a changed default** (#2419).
A seed call written `seed (entry, adopt_new_default)` moves a row whose value still equals the default its previous build stored to the new default, once, and records that default so the next start finds nothing to do; a value the user moved off the old default is kept, and so is every entry that does not opt in.
Opt-in is per entry because a default can differ with no build having changed it: `workers` seeds from the machine's core count, and a workspace file moved to another machine must keep its row.
Only `dbSynchronous` opts in.

**requires_restart / advanced / keywords** are NOT NULL with a `default_value` (false, false and `"[]"`), so `sync_schema` adds them to an existing table with `ALTER TABLE ADD COLUMN` rather than a copy-and-recreate.
They are metadata, not user data: every startup re-seeds each row's metadata (values are preserved), so the backfill only holds between the ALTER and that upsert.
`requires_restart` replaced a `"(Requires Restart)"` suffix in `label` that the app and the MCP tool surface both parsed out of the prose - one stale label misinformed both at once, and a test now asserts no label carries the substring.

**keywords** is JSON-in-TEXT like `options`, but never null: an entry with no terms stores `"[]"`, so `GET /config` always sends an array and no client branches on absent-vs-empty.
It holds what a user types that the entry's key, label and description never say ("ram" for `dbCacheSize`), which is why a seeded keyword may not repeat a word those three fields already carry - the search matches them first and ranks them above keywords, so a duplicate only lifts the entry over better matches.
`config_route_test.cpp` scans the seeded catalogue for both rules.

**unit** is nullable, like `min_value` / `max_value`: an entry that measures nothing declares none, and NULL is that - a nullable column is ALTER-friendly without a `default_value`.
It is what lets the app put the unit on the input where a unit belongs, and `"bytes"` additionally selects the human-readable size formatting.
The app reads that last part from this column, not from a list of keys it keeps itself: such a list is the "one branch defines, another re-derives" shape, and an entry seeded here would stay invisible to it until someone edited a TypeScript array.
`config_route_test.cpp` guards that every key ending `Ms` / `Bytes` / `Days` declares the matching unit, that no non-numeric entry declares one, and that no description restates a unit the input already carries.

**options** is nullable and populated only for `type: "enum"` entries.
It is JSON-in-TEXT, the same convention as every other structured column in this schema (`variables`, `auth`, `config_snapshot`, ...), never a delimited string.
Labels travel with values so the Settings UI never holds its own value-to-label map that could drift from the engine's.
`min_value` / `max_value` were considered and rejected as a place to carry the option list - they are engine-side validation only and unread by the app, whereas `options` is part of the client contract: the renderer cannot draw the dropdown without it.

Three entries are seeded as `enum` today (via `ConfigSeeder` in `engine/src/db/config_seeds/`).
Two of them derive their `options` from the C++ enumeration that gives the values meaning, rather than from a literal list, so the picker cannot offer a value the engine rejects or omit one it accepts.

**`defaultHttpVersion`** derives from the same `HttpVersion` enumeration that validates `requests.http_version` - see [`requests`](collections-and-requests.md#requests) above:
```json
[
  {"value": "auto", "label": "Auto"},
  {"value": "http1.1", "label": "HTTP/1.x"},
  {"value": "http2", "label": "HTTP/2"}
]
```
Its `value` is this instance's current global, read fresh (not cached) on every request create; changing it applies to the next request created, never retroactively.

**`proxyMode`** derives from `all_proxy_modes()` (`engine/include/vayu/http/transport_policy.hpp`), the same enumeration `resolve_transport_policy` parses the stored value back into:
```json
[
  {"value": "environment", "label": "From environment"},
  {"value": "system", "label": "From system"},
  {"value": "manual", "label": "Manual"},
  {"value": "off", "label": "None"}
]
```
It sits beside three plain `string` entries, `proxyUrl`, `proxySystemUrl` and `proxyBypass`, and the four are read together as one policy at the point of use
- see [Proxy settings](../api-reference/health-config.md#proxy-settings) for the values, the cross-field rule `POST /config` enforces over `proxyMode` + `proxyUrl`, and why `proxyUrl` holds credentials in plaintext exactly as `oauth_tokens` does.
`proxySystemUrl` is the one config row the **app** writes rather than the user: the Electron main process resolves the operating system's proxy through Chromium and stores the answer there for `system` mode to read.
It is a visible row rather than a hidden channel, because a proxy a user cannot see is the failure this whole area exists to end.

**`customCaCertificates`** is the one `text` entry - a multi-line string, which is a rendering distinction rather than a value-space one: the app draws a textarea for it because what it holds is pasted PEM whose line breaks are the format.
The certificates themselves are public, so nothing here is a credential; the engine materializes them as `ca-bundle.pem` beside this database (see [TLS trust settings](../api-reference/health-config.md#tls-trust-settings)), which is derived state a delete only costs a rewrite.

**`dbSynchronous`** is the exception: SQLite's durability levels (`"0"` Off, `"1"` Normal, `"2"` Full) are its enumeration rather than ours, so that one list is literal.
After a power cut or an operating-system crash, **Off** can leave the whole workspace file corrupt; **Normal**, the default, cannot corrupt it but may lose the last few seconds of writes (in WAL it syncs only at a checkpoint, so a commit costs no fsync); **Full** keeps every committed write at the cost of a sync per commit.
A workspace still holding the old default (Off, before #2419) moves to Normal once at the first start of the build that changed it; one that had picked Normal or Full keeps its choice.
