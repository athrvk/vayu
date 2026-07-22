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
| Insomnia Export v4 | `insomnia-v4.ts` | `_type === "export"` && `__export_format === 4` | [insomnia-v4.md](./insomnia-v4.md) |
| OpenAPI 3.0 | `openapi-v3.ts` | `openapi` starts with `3.` | [openapi-v3.md](./openapi-v3.md) |
| OpenAPI 2.0 (Swagger) | `openapi-v2.ts` | `swagger === "2.0"` | [openapi-v2.md](./openapi-v2.md) |

---

## Pipeline overview

A raw import string flows through three stages:

```
raw string ──▶ parseImport() ──▶ assignIds() ──▶ ImportOrchestrator.run()
              (factory.ts)       (assign-ids.ts)   (orchestrator.ts)
                  │                   │                  │
            detect + parse      stamp col_/req_/    create tree (+envs),
            → ImportResult      env_ UUIDs in-place rollback on failure
```

### 1. Detect + parse - `factory.ts`

`parseImport(raw, opts, fileName?)`:

1. **`parseRaw`** - `JSON.parse(raw)`, falling back to `yaml.load(raw)` on JSON failure.
   Malformed YAML throws and propagates as a parse error.
2. Runs each parser's `detect()` in a fixed **most-specific-first** order:
   `PostmanV21 → PostmanV20 → InsomniaV4 → OpenApiV3 → OpenApiV2`.
   The first parser whose `detect()` returns `true` gets to `parse()`.
3. No match → throws `UnrecognisedFormatError`.

The factory parses the raw text **once** and hands every detector the already-parsed
object (plus the raw string). This is a conscious divergence from the PRD's
`detect(raw: string)` - detectors receive `(parsed, raw)`.

### 2. Assign IDs - `assign-ids.ts`

`assignIds(result)` walks the draft tree and stamps every collection, request, and
environment with a client-side UUID (`col_…` / `req_…` / `env_…`) **in place**, before any
create call. This removes the engine's `now_ms()` id-collision risk and lets parent
references resolve without server round-trips. The orchestrator throws if it sees an
unassigned draft.

### 3. Persist - `orchestrator.ts`

`ImportOrchestrator` takes an injected `ImportApi` (easy to fake in tests) and exposes
`run(result, opts)`:

- Creates each root collection, then `createTree` recurses: **collection → its requests →
  child collections**, passing `order` indices. Each request is created with
  `bodyType = body.mode` (the engine never derives this).
- Environments are created **only if `opts.importEnvironments`** is true.
- On any error mid-run it calls **`rollback()`** - best-effort deletion of every
  already-created root collection (the engine's `delete_collection` cascades to descendant
  collections + requests) and every created environment - then
  rethrows the original error. Rollback completeness depends on that engine cascade.

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

Parsers emit drafts, not engine rows. IDs are absent until `assignIds` runs.

**`ImportResult`**
| Field | Type | Notes |
|---|---|---|
| `collections` | `CollectionDraft[]` | Root collections (`parentId = null`) |
| `environments` | `EnvironmentDraft[]` | Persisted only if `importEnvironments` |
| `meta` | `ImportMeta` | Counts + lossy-import signals for the Preview UI |

**`CollectionDraft`** - `name`, `description`, `variables: Record<string, VariableValue>`,
`auth` (a concrete `RequestAuth` - **never** `inherit`; collections are always concrete auth
sources), `preRequestScript`, `postRequestScript`, `children: CollectionDraft[]`,
`requests: RequestDraft[]`.

**`RequestDraft`** - `name`, `description`, `method: HttpMethod`, `url`,
`params: KeyValueEntry[]`, `headers: KeyValueEntry[]`, `body: RequestBody`,
`auth: RequestAuth` (**`inherit` allowed**, resolved against the collection chain at
execution time), `preRequestScript`, `postRequestScript`.

**`EnvironmentDraft`** - `name`, `description`, `variables: Record<string, VariableValue>`.

**`ImportMeta`** - `format`, `fileName?`, `requestCount`, `folderCount`,
`environmentCount`, `skipped: SkippedItem[]`, `nonExecutableAuth: number`.

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
