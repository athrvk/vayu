# Import Collections - Parser Architecture

Developer reference for Vayu's import subsystem: how raw Postman / Insomnia / OpenAPI files
are detected, parsed into Vayu's internal draft model, and persisted.

**Code:** `app/src/services/importers/`

> This folder is the canonical reference for parser internals. Document behavior **from the
> code** - when in doubt, the source in `app/src/services/importers/` wins.

## Per-format docs

| Format | Module | Detection (summary) | Doc |
|---|---|---|---|
| Postman Collection v2.1 / v2.0 | `postman.ts` | `info.schema` contains `v2.1.0` / `v2.0.0` (or `info`+`item` with no schema) | [postman.md](./postman.md) |
| Postman Environment / Globals | `postman-environment.ts` | `_postman_variable_scope` is `"environment"` or `"globals"` && `values` is an array | [postman-environment.md](./postman-environment.md) |
| Insomnia Export v4 | `insomnia-v4.ts` | `_type === "export"` && `__export_format === 4` | [insomnia-v4.md](./insomnia-v4.md) |
| OpenAPI 3.0 | `openapi-v3.ts` | `openapi` starts with `3.` | [openapi-v3.md](./openapi-v3.md) |
| OpenAPI 2.0 (Swagger) | `openapi-v2.ts` | `swagger === "2.0"` | [openapi-v2.md](./openapi-v2.md) |

---

## Pipeline overview

A raw import string flows through three stages:

```
raw string ──▶ parseImport() ──▶ assignTempIds() ──▶ ImportOrchestrator.run()
              (factory.ts)       (assign-ids.ts)      (orchestrator.ts)
                  │                   │                     │
            detect + parse      stamp opaque temp     flatten to one
            → ImportResult      ids (c1/r1/e1)        POST /import/apply
```

### 1. Detect + parse - `factory.ts`

`parseImport(raw, opts, fileName?)`:

1. **`parseRaw`** - `JSON.parse(raw)`, falling back to `yaml.load(raw)` on JSON failure.
   Malformed YAML throws and propagates as a parse error.
2. Runs each parser's `detect()` in a fixed **most-specific-first** order:
   `PostmanV21 → PostmanV20 → PostmanEnvironment → InsomniaV4 → OpenApiV3 → OpenApiV2`.
   The first parser whose `detect()` returns `true` gets to `parse()`.
3. No match → throws `UnrecognisedFormatError`.

The factory parses the raw text **once** and hands every detector the already-parsed
object (plus the raw string). This is a conscious divergence from the PRD's
`detect(raw: string)` - detectors receive `(parsed, raw)`.

### 2. Assign temp IDs - `assign-ids.ts`

`assignTempIds(result)` walks the draft tree and stamps every collection, request, and
environment with a **temp id** (`c1` / `r1` / `e1` counters) **in place**, before the
import is sent. These are opaque per-call strings, not record ids: they exist so one item
in the payload can reference another (`parentTempId`, `collectionTempId`) while no real ids
exist yet, and they are never stored. The orchestrator throws if it sees an unstamped
draft.

This used to mint real `col_…` / `req_…` / `env_…` UUIDs, because the orchestrator created
items one POST at a time and had to wire the tree itself - which is the only reason
`POST /<resource>` ever accepted a client-supplied `id`. It no longer does: since #97 a
create carrying an `id` is a `400`, on the single-resource routes and per item in
`/import/apply` alike.

### 3. Persist - `orchestrator.ts`

`ImportOrchestrator` takes an injected `ImportApi` (easy to fake in tests) and exposes
`run(result, opts)`, which flattens the draft tree into **one**
[`POST /import/apply`](../../engine/api-reference.md#post-importapply) call:

- Collections are flattened depth-first - **collection → its requests → child
  collections** - carrying `order` indices and `parentTempId` (`null` for a root);
  each request carries `collectionTempId` and `bodyType = body.mode` (the engine never
  derives this).
- Environments are included **only if `opts.importEnvironments`** is true.
- The engine generates every real id and returns an `idMap` keyed by temp id. The
  orchestrator checks that map covers every item it sent and throws
  `Import incomplete: …` otherwise - a silently skipped item would otherwise read as a
  clean import. Note this throw happens *after* the tree is committed. Nothing else
  consumes the real ids: `useImportMutation` invalidates the collection / request /
  environment / globals queries, which refetch.
- **No rollback, and no retry.** The engine write is atomic (validation over the whole
  payload, then one transaction), so a *rejected* payload persisted nothing and the error
  the modal shows is the engine's, naming the item that broke. The old per-item loop needed
  best-effort deletion of already-created roots; that code is gone. What atomicity does
  **not** cover is a lost response: `/import/apply` has no idempotency key and mints fresh
  ids per temp id on every call, so a second attempt after a committed-but-unanswered write
  is a second copy of the whole tree. `useImportMutation` therefore sets `retry: false`,
  overriding the QueryClient's `retry: 1` mutation default, and invalidates in `onSettled`
  rather than `onSuccess` so a tree that landed behind a later failure is still visible.
- **Globals are the one write outside that payload.** They are an engine singleton behind
  `POST /globals`, not a tree item with a temp id, so `applyGlobals` runs as a second
  request *after* the apply and its id-map check - nothing may fail behind it, since it is
  the only write here that can destroy data the import did not create. The trade is the
  one partial outcome left: the tree lands, the globals write fails, and the error
  surfaces with no rollback to undo the apply. See
  [postman-environment.md](postman-environment.md#globals-merge-they-do-not-replace).

`orchestrator.fixture-parity.test.ts` pins the payload against a reference implementation
of that deleted per-item walk, per fixture, so the flattening cannot quietly drop a field
or renumber an `order`.

---

## The `ImportParser` interface

Every parser implements (`types.ts`):

```ts
interface ImportParser {
  readonly formatName: string; // e.g. "Postman Collection v2.1"
  readonly formatKey: string;  // e.g. "postman-v21"
  detect(parsed: unknown, raw: string): boolean;
  parse(parsed: unknown, raw: string, opts: ImportOptions): ImportResult;
}
```

`parse()` never persists - it only produces an `ImportResult`. Persistence is the
orchestrator's job.

---

## Draft model (the parser output contract)

Parsers emit drafts, not engine rows. A draft's `tempId` is absent until
`assignTempIds` runs; no draft ever carries a real record id.

**`ImportResult`**
| Field | Type | Notes |
|---|---|---|
| `collections` | `CollectionDraft[]` | Root collections (`parentId = null`) |
| `environments` | `EnvironmentDraft[]` | Persisted only if `importEnvironments` |
| `globals` | `Record<string, VariableValue>` | Variables for the globals scope, keyed by name. Not a draft list - globals are an engine singleton, so there is no name and no temp id to assign. Required, so every parser states its answer: `{}` for all but the Postman globals export |
| `meta` | `ImportMeta` | Counts + lossy-import signals for the Preview UI |

**`CollectionDraft`** - `name`, `description`, `variables: Record<string, VariableValue>`,
`auth` (a concrete `RequestAuth` - **never** `inherit`; collections are always concrete auth
sources), `preRequestScript`, `postRequestScript`, `children: CollectionDraft[]`,
`requests: RequestDraft[]`.

**`RequestDraft`** - `name`, `description`, `method: HttpMethod`, `url`,
`params: KeyValueEntry[]`, `headers: KeyValueEntry[]`, `body: RequestBody`,
`auth: RequestAuth` (**`inherit` allowed**, resolved against the collection chain at
execution time), `preRequestScript`, `postRequestScript`, `followRedirects?: boolean`.

`followRedirects` is optional because absent means "leave the engine's default",
which is `true`: a parser sets it only when the source file states it, and the
orchestrator forwards it to `POST /import/apply` only when set. Sending an omitted
`false` as `true` would follow a 3xx the user disabled; sending an absent value as
`false` would stop one they never touched. Insomnia's `settingFollowRedirects` is
the only producer today; no format in the pipeline carries a per-request redirect
*limit*, so there is no `maxRedirects` on the draft.

**`EnvironmentDraft`** - `name`, `description`, `variables: Record<string, VariableValue>`.

**`ImportMeta`** - `format`, `fileName?`, `requestCount`, `folderCount`,
`environmentCount`, `globalCount`, `skipped: SkippedItem[]`, `nonExecutableAuth: number`.

**`SkippedItem`** - `{ kind: "websocket" | "grpc" | "api_spec" | "unit_test" | "file_body", count }`.
Surfaces work Vayu can't represent so the Preview can warn instead of silently dropping.

Supporting value types:
- `KeyValueEntry`: `{ key, value, enabled, description? }` - duplicates and `enabled:false`
  rows are preserved.
- `VariableValue`: `{ value: string, enabled: boolean, secret? }` - all values are strings.
- `RequestBody`: `{mode:"none"}` | `{mode:"json"|"text"|"graphql", content}` |
  `{mode:"form-data"|"x-www-form-urlencoded", fields: KeyValueEntry[]}`.
- `RequestAuth`: `{mode:"none"}` | `{mode:"inherit"}` | `{mode:"bearer", token}` |
  `{mode:"basic", username, password}` | `{mode:"apikey", key, value, in}` |
  `{mode:"oauth2", config: OAuth2Config}` (executable) |
  `{mode:"digest"|"aws"|"ntlm", config}` (stored, not executed).

---

## `ImportOptions` semantics

```ts
interface ImportOptions { importEnvironments: boolean; importScripts: boolean; }
```

Options are applied at **parse time** - parsers emit empty scripts / skip environments when
told to. The orchestrator only re-checks `importEnvironments` (to decide whether to persist
the environment drafts). Honoring is **per-parser**:

| Parser | `importScripts` | `importEnvironments` |
|---|---|---|
| Postman v2.1 / v2.0 | Honored - scripts emitted as `""` when false | Moot - collection files embed no environments |
| Postman Environment / Globals | Moot - this shape carries no scripts | Honored - gates both `environments` and `globals` at parse time, so the Preview counts report 0 |
| Insomnia v4 | Honored | Honored - `environment` resources become `EnvironmentDraft`s |
| OpenAPI 3.0 | Ignored - never generates scripts | Ignored - never generates environments |
| OpenAPI 2.0 (Swagger) | Ignored | Ignored |

The two OpenAPI parsers take `_opts` and never read it (they produce spec-derived stubs with
no scripts and no environments).

---

## Shared helpers

Reusable mapping helpers consumed by the parsers. Postman and Insomnia lean on `shared.ts`;
the OpenAPI parsers use only `normalizeVars` and `sampleSchema`.

### asString
`asString(v): string` - coerces any scalar to its string form; objects are `JSON.stringify`-d;
`null`/`undefined` → `""`. Vayu stores all values as strings. (`shared.ts`)

### toVarRecord
`toVarRecord(vars)` - Postman/Insomnia variable arrays (`{key, value?, enabled?, disabled?}`)
→ `Record<string, VariableValue>`. `disabled` takes precedence over `enabled`; default
`enabled: true`. Values pass through `normalizeVars`. Rows without a `key` are skipped.
(`shared.ts`)

### mapKeyValues
`mapKeyValues(rows)` - Postman header/query/urlencoded arrays → `KeyValueEntry[]`. Sets
`enabled = r.disabled !== true`, normalizes each value, carries `description` when present,
and **preserves duplicates and disabled rows**. (`shared.ts`)

### mapPostmanAuth
`mapPostmanAuth(auth)` - a Postman `auth` object (collection / folder / request) → `RequestAuth`.
Reads the per-type detail via `authDetail`, which handles both v2.1's array shape
(`[{key, value}]`) and v2.0's object shape. Maps `bearer`/`basic`/`apikey` to concrete auth,
maps `oauth2` to an **executable** `{mode:"oauth2", config}` via `mapPostmanOAuth2` (below),
stores `digest`/`aws`/`ntlm` as `{mode, config}` (not executed), `noauth` → `none`, and
missing/`inherit` → `inherit`. (`shared.ts`)

### OAuth 2.0 mapping (`oauth2-import.ts`)
Turns each source format's OAuth 2.0 block into Vayu's typed `OAuth2Config`, so imported
OAuth 2.0 auth is **executable** (not a passive `{mode, config}` bag):
- `mapPostmanOAuth2(params)` - Postman v2.1 `oauth2` params, incl. grant normalization
  (`authorization_code_with_pkce` → auth-code + PKCE; `implicit` → auth-code + PKCE; a minimal
  export with only a pre-fetched `accessToken` → a bearer token).
- `mapInsomniaOAuth2(auth)` - Insomnia's camelCase `oauth2` object.
- `mapOpenApiV3OAuth2(scheme)` / `mapSwaggerOAuth2(scheme)` - pick the first usable flow from an
  OpenAPI v3 / Swagger v2 `oauth2` security scheme (client id/secret seeded as `{{variables}}`).

Grant/field normalization is shared here so the parsers agree. Only `digest`/`aws`/`ntlm`
remain non-executable and are counted in `meta.nonExecutableAuth`.

### rawBody
`rawBody(content, language)` - Postman raw body → `RequestBody`. `json`/`text` map directly;
with no explicit language it sniffs via `JSON.parse` (success → `json`, else `text`).
(`shared.ts`)

### joinExec
`joinExec(event)` - a Postman event entry → a single script string. Joins
`event.script.exec[]` with `\n` (or returns a string `exec` as-is). (`shared.ts`)

### normalizeVars
`normalizeVars(input)` - normalizes foreign template syntax to Vayu `{{var}}`:
`{{ x }}` / `{{ _.x }}` → `{{x}}` (trimmed, `_.` prefix stripped) and OpenAPI single-brace
`{x}` → `{{x}}` (without touching an existing `{{…}}` pair). Nunjucks tags `{% … %}` and
filtered vars `{{ x | filter }}` are left **verbatim** - Vayu has no equivalent and renders
them as literal text. (`var-normalize.ts`)

### sampleSchema
`sampleSchema(schema, resolveRef)` - generates a sample value for an OpenAPI/Swagger schema,
used to build request-body stubs. It is **bounded and resilient**, not a naive one-level walk:

- Recurses up to `MAX_DEPTH = 6`.
- Resolves `$ref` via the injected `resolveRef`, with a per-path `Set` **cycle guard**
  (a re-seen ref → `{}`); a failed/`null` resolution → `{}`.
- Returns a schema's `example` verbatim when present.
- For `allOf` / `oneOf` / `anyOf`, walks the **first** branch (precedence `allOf → oneOf → anyOf`).
- Type defaults: `string` → `""` (or `enum[0]`), `integer`/`number` → `0`, `boolean` →
  `false`, `array` → `[sample(items)]` (or `[]`), `object`/untyped → expands `properties`
  recursively (else `{}`).

(`schema-sampler.ts`)

---

## Adding a new parser

1. Implement `ImportParser` in a new module under `app/src/services/importers/`.
2. Reuse `shared.ts` / `var-normalize.ts` / `schema-sampler.ts` where they fit; emit the
   draft model above (no IDs, no persistence).
3. Register the instance in `factory.ts`'s `PARSERS` array at the correct
   **most-specific-first** position so its `detect()` doesn't shadow (or get shadowed by)
   another format.
4. Populate `meta.skipped` / `meta.nonExecutableAuth` for anything Vayu can't execute or
   represent, so the Preview can warn the user.
5. Add a `docs/app/import-collections/<format>.md` following the structure of the existing
   per-format docs, and a row in the table at the top of this file.
