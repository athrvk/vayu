---
description: >-
  How Vayu's import pipeline turns a Postman, Insomnia, OpenAPI or Swagger file into a collection - detection, parsing, and what gets skipped.
---

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

A raw import string flows through three stages, once per document:

```
picked files ──▶ detectBatch() ──▶ parseImport() ──▶ assignTempIds() ──▶ ImportOrchestrator.run()
                 (batch.ts)        (factory.ts)      (assign-ids.ts)      (orchestrator.ts)
                     │                  │                  │                     │
             one row per file,   detect + parse      stamp opaque temp     flatten to one
             bundle its $refs    → ImportResult      ids (c1/r1/e1)        POST /import/apply
```

### 0. The batch - `batch.ts`

Entry is per **file**, not per import: the File tab takes a multi-file drop or
selection, and "Import folder" takes a whole directory (`webkitdirectory`,
recursing, filtered to `IMPORTABLE_EXTENSIONS` - `.json` / `.yaml` / `.yml`). The
URL and Paste tabs are single by construction and travel the same path as a
one-entry batch, so there is no second flow beside this one to drift from it.

`detectBatch(documents, opts, intake)` returns one `BatchEntry` per picked file,
in pick order, and **every picked file gets a row** - that is the property the
whole module exists for. The dialog used to read `e.dataTransfer.files[0]` with
no `multiple` on the input, so dropping a folder's worth of specs imported the
first and discarded the rest without a word (issue #666). A row saying
"Unrecognised format" is the flow working; no row is the bug.

An entry carries the bundled `raw` text, its `result` **or** its `error`, the
unresolved-ref count, and its `included` state. Three row states are not
failures and are not errors:

| Row state | What it means |
|---|---|
| `error` | Unreadable, unparseable, unrecognised, or over the spec byte cap. Listed, unchecked. |
| `bundledInto` | Another picked document inlined this file as a `$ref` target. It is part of that spec, so it is never applied on its own - which is also what stops a split spec importing twice. |
| parsed but empty | Parsed fine, but the options left nothing to create. Included stays available; Import stays disabled while it is the only file. |

**Siblings come from the batch first.** `bundleExternalRefs` reads a referenced
file through the gated `specFile:read` IPC; when that file is already in the
batch its text is right here, so the batch answers and nothing touches disk. Ref
targets are resolved with the bundler's own `joinRelative` / `dirOf` against the
entry's `webkitRelativePath`, rather than a second normalizer that could disagree
about `..`.

**Apply is per file, sequentially** - each entry is its own
`POST /import/apply` transaction, so a seventh file the engine refuses cannot
roll back six good ones, and each lands as its own root collection (exactly what
N manual imports produce). The ledger states each outcome; an applied row is
unchecked and disabled, because the route is create-only with no idempotency key
and a second send is a second copy of the tree. A combined single-payload apply
was considered and rejected: all-or-nothing across unrelated files is the wrong
failure mode, and per-file leaves the engine contract untouched.

**Zip import is a named non-goal.** No major tool exports collection zips today
(Postman exports single JSON files; vendors ship git repos). Reopen when a real
source ships them.

### 1. Detect + parse - `factory.ts`

`parseImport(raw, opts, fileName?)`:

1. **`parseRaw`** - `JSON.parse(raw)`, falling back to `yaml.load(raw)` on JSON failure.
   Malformed YAML throws and propagates as a parse error.
2. Runs each parser's `detect()` in a fixed **most-specific-first** order:
   `PostmanV21 → PostmanV20 → PostmanEnvironment → InsomniaV4 → OpenApiV3 → OpenApiV2`.
   The first parser whose `detect()` returns `true` gets to `parse()`.
3. No match → throws `UnrecognisedFormatError`.
4. **Joins each request's enabled params into its `url`** - see
   [The url/params invariant](#the-urlparams-invariant) below.

The factory parses the raw text **once** and hands every detector the already-parsed
object (plus the raw string). This is a conscious divergence from the PRD's
`detect(raw: string)` - detectors receive `(parsed, raw)`.

#### The url/params invariant

A stored request carries its **enabled** query inside `url`; `params[]` mirrors
it for the editor, disabled rows included (see
[request-storage-design.md](../../request-storage-design.md)). `url` is what
every execution path sends verbatim, and no engine path reads `params[]` at all.

Every parser states the query some other way - Postman splits it out of the URL
into `params[]`, Insomnia keeps a `parameters[]` beside a verbatim URL, the
OpenAPI parsers synthesize params for a URL that never had a query - so an
imported request used to go on the wire with its query missing, silently, until
the user happened to edit the Params table once (issue #590).

`parseImport` closes that with one pass over every request draft,
`appendParamsToUrl(r.url, r.params)`
(`modules/request-builder/utils/url.ts`, shared with the Params table rather than
copied). It **appends**, so a URL that arrived with a query of its own keeps it -
which is what Insomnia's own send does with its two sources. Each parser's
mapping stays as documented: `params[]` is still exactly what the source
declared, and only the enabled rows reach `url`.

Two consequences worth expecting:

- A row disabled in the source stays in the table and out of the URL.
- A row with a key and no value joins as a **bare key** (`?verbose`), which is
  what the Params table writes for the same row. The OpenAPI parsers import an
  optional value-less parameter **disabled** so this does not happen for a
  parameter the spec merely documents - only a `required` one, or one carrying a
  declared value, reaches the URL. Declared **header** parameters follow the same
  rule (see
  [Parameter values & enabled state](./openapi-v3.md#parameter-values--enabled-state)).

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
  the modal shows is the engine's, naming the item that broke. The engine names it by
  `tempId` (inside the error object - see
  [api-reference](../../engine/api-reference.md));
  `importFailureMessage` (`services/importers/failure-message.ts`) resolves that back to
  the name shown in the preview, since `c37` means nothing to whoever chose the file.
  The old per-item loop needed
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
execution time), `preRequestScript`, `postRequestScript`, `followRedirects?: boolean`,
`maxRedirects?: number`, `examples?: ExampleDraft[]`.

Both redirect fields are optional because absent means "leave the engine's default"
(`followRedirects: true`, `maxRedirects: 10`): a parser sets one only when the source
file states it, and the orchestrator forwards it to `POST /import/apply` only when set.
Sending an omitted `false` as `true` would follow a 3xx the user disabled; sending an
absent value as `false` would stop one they never touched. Producers: Postman's
item-level `protocolProfileBehavior` (both fields, see [postman.md](./postman.md)) and
Insomnia's `settingFollowRedirects` (`followRedirects` only - its redirect *limit* is an
app-wide setting, not a per-request field, see [insomnia-v4.md](./insomnia-v4.md)).

**`ExampleDraft`** - `name`, `status: number`, `headers: KeyValueEntry[]`, `body: string`,
`contentType: string`. A saved example response the source file carried next to the request
(issue #481): Postman's `item.response[]`, an OpenAPI operation's `responses`. Every parser
dropped these before the engine had a table for them - not even counted as skipped. They
carry no id: the engine assigns one, and the orchestrator nests them on the request item of
`POST /import/apply` rather than sending a fourth top-level section, since nothing references
an example. `examples` is optional for the same reason the redirect fields are: a parser with
no concept of saved responses must not look like one that found none, and array order is the
stored order - a mock server answers with the first example of a matched request.

**`EnvironmentDraft`** - `name`, `description`, `variables: Record<string, VariableValue>`.

**`ImportMeta`** - `format`, `fileName?`, `requestCount`, `folderCount`,
`environmentCount`, `globalCount`, `exampleCount`, `skipped: SkippedItem[]`,
`nonExecutableAuth: number`, `unattachedFileParts: number`.

`exampleCount` totals the saved example responses across the whole tree, from
`countExamples(collections)` in `shared.ts` - read off the finished drafts for the same
reason `unattachedFileParts` is, so the number the preview promises and the drafts about to
be written cannot disagree.

`unattachedFileParts` counts form-data file rows the import produced with no file attached -
an OpenAPI spec documents *that* a field is an upload, never *which* file, so those rows
import complete-but-empty and the user picks the file. Every parser gets it from
`unattachedFileParts(collections)` in `shared.ts`, which reads the finished drafts rather
than tallying while building them, so the number and the rows cannot disagree.

**`SkippedItem`** - `{ kind: "websocket" | "grpc" | "api_spec" | "unit_test" | "file_body" |
"malformed_item" | "unsupported_method" | "malformed_spec" | "example_no_status" |
"external_ref", count }`.
Surfaces work Vayu can't represent so the Preview can warn instead of silently dropping.
Three of the kinds are not about representability: `unsupported_method` is an operation whose
HTTP method has no `HttpMethod` (OpenAPI 3's `trace`), and `malformed_item` / `malformed_spec`
are shapes the source file got wrong - a Postman `item[]` entry that is not an object (see
[postman.md](./postman.md)), an OpenAPI path item or `parameters` list that is not what the
spec allows - stepped over so the rest of the file still imports. The two OpenAPI kinds are
counted via `SkipTally` in `openapi-shared.ts`, shared by both OpenAPI parsers: they are
structural clones, and a second copy would drift. `example_no_status` is a fourth
non-representability case: an OpenAPI response keyed `default` or `2XX` documents a real
response, but an example is served under one status line and there is no honest value to
pick, so it is counted rather than guessed at. `external_ref` is the fifth, and the only
kind no parser produces: a `$ref` naming another file that the bundling pass could not
read (`ref-bundler.ts`, issue #649) is counted **before** parse and stamped into
`meta.skipped` by `parseImport`, one per reference - because each one is an operation that
imported without the schema it declared.

Supporting value types:
- `KeyValueEntry`: `{ key, value, enabled, description? }` - duplicates and `enabled:false`
  rows are preserved.
- `VariableValue`: `{ value: string, enabled: boolean, secret? }` - all values are strings.
- `RequestBody`: `{mode:"none"}` | `{mode:"json"|"text"|"graphql"|"jsonrpc"|"xml", content}` |
  `{mode:"form-data"|"x-www-form-urlencoded", fields: KeyValueEntry[]}`.
- `RequestAuth`: `{mode:"none"}` | `{mode:"noauth"}` | `{mode:"inherit"}` | `{mode:"bearer", token}` |
  `{mode:"basic", username, password}` | `{mode:"apikey", key, value, in}` |
  `{mode:"oauth2", config: OAuth2Config}` (executable) |
  `{mode:"digest"|"aws"|"ntlm", config}` (stored, not executed).
  On a collection, `none` means "nothing set here" (a descendant's `inherit` keeps
  climbing) and `noauth` means "send nothing" (the walk stops there) - see
  [Postman auth mapping](./postman.md#auth-mapping).

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
stores `digest`/`aws`/`ntlm` as `{mode, config}` (not executed), maps the real AWS wire type
`awsv4` → the internal `{mode:"aws", config}`, `noauth` → `none`, and missing/`inherit` →
`inherit`. A collection/folder `noauth` is handled by `collectionAuth` in `postman.ts` instead,
which maps it to the terminal `{mode:"noauth"}`. (`shared.ts`)

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
`rawBody(content, language)` - Postman raw body → `RequestBody`. `json`/`text`/`xml` map
directly; with no explicit language it sniffs via `JSON.parse` (success → `json`, else
`text`) and never guesses `xml`.
(`shared.ts`)

### joinExec
`joinExec(event)` - a Postman event entry → a single script string. Joins
`event.script.exec[]` with `\n` (or returns a string `exec` as-is). (`shared.ts`)

### normalizeVars
`normalizeVars(input, opts?)` - normalizes foreign template syntax to Vayu `{{var}}`:
`{{ x }}` / `{{ _.x }}` → `{{x}}` (trimmed, `_.` prefix stripped). With
`{ pathTemplates: true }` it additionally rewrites single-brace `{x}` → `{{x}}` (without
touching an existing `{{…}}` pair); **only the OpenAPI/Swagger parsers pass it**, because in
Postman and Insomnia a single brace is literal text (`/tags/{beta}`, `fields=friends{name}`)
and rewriting it invents a variable reference that resolves to nothing. Nunjucks tags
`{% … %}` and filtered vars `{{ x | filter }}` are left **verbatim** - Vayu has no equivalent
and renders them as literal text. (`var-normalize.ts`)

### Dynamic variables in imported collections

Postman and Bruno collections routinely contain `{{$guid}}`, `{{$timestamp}}`
and the `{{$random*}}` faker names. The importers pass them through untouched -
`normalizeVars` only trims and strips a `_.` prefix - and **they now resolve**
at send time from the generator table described in
[variable resolution](../variable-resolution.md#dynamic-variables). Before that
table existed they resolved to an empty string, so an imported request whose
body carried a `{{$guid}}` sent an empty field and the import looked successful.

A `$name` outside the supported set is left written as `{{$name}}` in the
outgoing request rather than emptied, so an imported collection using a faker
value Vayu does not have shows it instead of hiding it.

### sampleSchema
`sampleSchema(schema, resolveRef)` - generates a sample value for an OpenAPI/Swagger schema,
used to build request-body stubs. It is **bounded and resilient**, not a naive one-level walk:

- Recurses up to `MAX_DEPTH = 6`.
- Resolves `$ref` via the injected `resolveRef`, with a per-path `Set` **cycle guard**
  (a re-seen ref → `{}`); a failed/`null` resolution → `{}`.
- Returns a pinned value verbatim, `const` → `example` → `examples[0]`. `const` wins because
  JSON Schema makes it the only permitted value; `examples` is OpenAPI 3.1's plural form.
- For `allOf` / `oneOf` / `anyOf`, walks the **first** branch (precedence `allOf → oneOf → anyOf`).
- Samples a 3.1 type array (`type: ["string", "null"]`) from its first non-`"null"` member.
- Type defaults: `string` → `""` (or `enum[0]`), `integer`/`number` → `0`, `boolean` →
  `false`, `null` → `null`, `array` → `[sample(items)]` (or `[]`), `object`/untyped → expands
  `properties` recursively (else `{}`).

`schemaFormFields(schema, resolveRef)` in the same module returns the sampled stub's own keys
(`[]` when it samples to a non-object), each flagged `file` or not. It is how the v3 parser
reads urlencoded / multipart field names, so a form schema behind `$ref` or `allOf` resolves
as far as a JSON body does instead of reading a `properties` key that isn't there. The `file`
flag comes from the property schema (`format: binary`, or an array of it) rather than the
sampled value, which flattens a binary string to `""` and cannot be told from a text field.

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
   represent, and `meta.unattachedFileParts` (via the `shared.ts` helper) for uploads the
   user still has to attach, so the Preview can warn the user.
5. Add a `docs/app/import-collections/<format>.md` following the structure of the existing
   per-format docs, and a row in the table at the top of this file.
