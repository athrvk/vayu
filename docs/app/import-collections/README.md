---
description: >-
  How Vayu's import pipeline turns a Postman, Insomnia, OpenAPI or Swagger file into a collection - detection, parsing, and what gets skipped.
---

# Import Collections - Parser Architecture

Developer reference for Vayu's import subsystem: how raw Postman / Insomnia / OpenAPI files
are detected, parsed into Vayu's internal draft model, and persisted.

**The parse is the engine's** since issue
[#877](https://github.com/athrvk/vayu/issues/877). Every format below is read by
`engine/src/core/import_document.cpp`, behind
[`POST /import/parse`](../../engine/api-reference.md#post-importparse), and the
app calls it. There is no parser in `app/src` any more, and that is the point:
the renderer's stack was the *second* reader of a document, which is what
[#853](https://github.com/athrvk/vayu/issues/853) set out to end - and while it
existed, an agent over MCP could bind, diff, sync and export a spec but could
not import one. It can now (`import_document`, see
[mcp.md](../../engine/mcp.md)).

**Code:** `engine/src/core/import_document.cpp` (the parse),
`app/src/services/importers/` (the batch ledger, the temp ids and the apply).

> This folder documents each format's **mapping rules** - what a Postman `auth`
> block becomes, which OpenAPI response becomes an example. Document behavior
> **from the code**: `engine/src/core/import_document.cpp` and, for the two
> OpenAPI dialects, `engine/src/core/openapi_drafts.cpp` (the request builder
> those rules are shared with) win when in doubt.

## Per-format docs

| Format | Detection (summary) | Doc |
|---|---|---|
| Postman Collection v2.1 / v2.0 | `info.schema` contains `v2.1.0` / `v2.0.0` (or `info`+`item` with no schema) | [postman.md](./postman.md) |
| Postman Environment / Globals | `_postman_variable_scope` is `"environment"` or `"globals"` && `values` is an array | [postman-environment.md](./postman-environment.md) |
| Insomnia Export v4 | `_type === "export"` && `__export_format === 4` | [insomnia-v4.md](./insomnia-v4.md) |
| OpenAPI 3.0 | `openapi` starts with `3.` | [openapi-v3.md](./openapi-v3.md) |
| OpenAPI 2.0 (Swagger) | `swagger` is `2.0` (string or number) | [openapi-v2.md](./openapi-v2.md) |

---

## Pipeline overview

A raw import string flows through three stages, once per document:

```
picked files ──▶ detectBatch() ──▶ parseImport() ──▶ assignTempIds() ──▶ ImportOrchestrator.run()
                 (batch.ts)        (factory.ts)      (assign-ids.ts)      (orchestrator.ts)
                     │                  │                  │                     │
             one row per file,   POST /import/parse  stamp opaque temp     flatten to one
             bundle its $refs    → ImportResult      ids (c1/r1/e1)        POST /import/apply
```

Each stage that waits reports how far through it is
(issue [#882](https://github.com/athrvk/vayu/issues/882)). `detectBatch` and
`reparseBatch` take an `onProgress` callback and tick as each document's promise
lands - the waves stay parallel, so what advances is a counter, never a queue -
and `ImportModal` adds the two stages either side of them: the URL download
(bytes, streamed off `POST /import/fetch`) and the apply, which is one
transaction per file and so counts files. Reading the picked files off disk gets
a name but no counter: `FileReader` is local and effectively instant, and a
number there would be motion without information. Every total is a real count of
real work - `parsing`'s is the documents that will actually be parsed, which is
fewer than the documents picked whenever one could not be read or was inlined
into another.

An agent has no dialog, so it takes the whole of that in one call:
[`POST /import`](../../engine/api-reference.md#post-import) is the parse, the
flattening and the apply together. The app deliberately does not use it - a
person picks which files of a batch to import and toggles two options between
the parse and the apply.

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

**A spec that is already bound forks before the apply** (issue #680). When
Import is pressed, every entry carrying a spec document is looked up against the
collections that bind one - by `spec_documents.source_url`, and by the stored
bytes - and a match offers Sync in that collection instead of importing a second
copy. The lookup lives in `services/openapi/bound-spec-match.ts`, reads the bound
documents through `useBoundSpecReader` (the Spec tab's own query cache), and runs
at Import rather than at detect time: it is a round trip per bound document, and
a preview should not pay for one. **Import anyway does exactly what Import did
before it existed** - the dialog is a fork, never a block - and an import with no
spec in it never reaches the lookup at all. See
[OpenAPI Collections](../openapi.md#importing-a-document-you-are-already-bound-to).

**Zip import is a named non-goal.** No major tool exports collection zips today
(Postman exports single JSON files; vendors ship git repos). Reopen when a real
source ships them.

### 1. Detect + parse - `factory.ts` → `POST /import/parse`

`parseImport(raw, opts, source?)` is one call to the engine. It is `async` since
#877; everything that consumed it - the batch, the modal's option toggles -
awaits.

Engine-side, in `core::parse_import`:

1. **One read** - `core::read_document`: JSON first, YAML second. The same reader
   behind `POST /specs` and `POST /specs/describe`, which is what makes "exactly
   one parser has an opinion about a document" true.
2. Detection in a fixed **most-specific-first** order:
   `Postman v2.1 → Postman v2.0 → Postman environment/globals → Insomnia v4 →
   OpenAPI 3.x → OpenAPI 2.0` - the order the renderer's `PARSERS` list ran in,
   so the same bytes are claimed by the same format they always were.
3. No match → `400 Unrecognised format`, which `factory.ts` turns back into
   `UnrecognisedFormatError`. Kept apart from a document that *claimed* a format
   and is broken (`400 Could not read the document: …`): the dialog says
   different things about the two.
4. **Joins each request's enabled params into its `url`** - see
   [The url/params invariant](#the-urlparams-invariant) below.

The two OpenAPI dialects are not a second reader either: their requests come from
`core::import_drafts_of`, the same builder the OpenAPI sync diff compares a
stored request against (issue #865), with the import composing the root
collection, the folders and the skip tally around it. A draft the two built
differently would report "the document changed this request" about a document
nobody edited.

**The move is pinned, not promised.** `engine/tests/fixtures/import-conformance.json`
holds, per format, what the renderer's own parsers produced for a corpus of
documents - recorded at the last commit that had them - and
`engine/tests/import_parse_test.cpp` asserts the engine produces the same thing
on every build.

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

**The flattening exists twice, and the two are pinned to each other.**
`POST /import` has no preview to show, so it flattens engine-side
(`core::import_apply_payload`); this orchestrator flattens a result a person has
previewed and filtered. Two implementations of one mapping is the defect this
repo keeps finding, in the one place a missing field is silent - a request that
imported without its examples looks exactly like a document that documented none
- so `orchestrator.payload-conformance.test.ts` and the engine's
`import_parse_test.cpp` build the payload for the same fixtures and must agree.

---

## Reading a document without parsing it

One renderer path still needs a document as a *tree*: `ref-bundler.ts`, which
inlines the files a multi-file OpenAPI document references before anything is
parsed or stored (issue #649). It reads through
[`POST /import/document`](../../engine/api-reference.md#post-importdocument) -
`core::read_document` and nothing else - so it holds no parser of its own, and
`js-yaml` is gone from production `src/`.

That is deliberate, and it is the line the bundler sits on: **fetch-time `$ref`
assembly is deterministic re-serialization, not an opinion about what a document
declares.** It stays renderer-side because it reaches the network through
`POST /import/fetch` and the local filesystem through the main-process-gated
`specFile:read` IPC, and an engine that read sibling files off disk on an
import's behalf would be a wider capability than any of this needs.

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
`folderStrategy?`, `environmentCount`, `globalCount`, `exampleCount`,
`skipped: SkippedItem[]`, `nonExecutableAuth: number`, `unattachedFileParts: number`.

`folderStrategy` (`"tags" | "paths" | "mixed"`) says which rule an OpenAPI import grouped its
folders by, and the Preview states it whenever paths were involved - a folder tree the
document never spelled out must not read as one it did (issue #710, see
[openapi-v3.md](./openapi-v3.md#tree-structure)). Only the two OpenAPI parsers set it: a
format that carries its own folders makes no such choice, and a parser that says nothing must
not look like one that said `"tags"`.

`exampleCount` totals the saved example responses across the whole tree, from
`count_examples(collections)` in `import_document.cpp` - read off the finished drafts for the same
reason `unattachedFileParts` is, so the number the preview promises and the drafts about to
be written cannot disagree.

`unattachedFileParts` counts form-data file rows the import produced with no file attached -
an OpenAPI spec documents *that* a field is an upload, never *which* file, so those rows
import complete-but-empty and the user picks the file. Every parser gets it from
`unattached_file_parts(collections)` in `import_document.cpp`, which reads the finished drafts rather
than tallying while building them, so the number and the rows cannot disagree.

**`SkippedItem`** - `{ kind: "websocket" | "grpc" | "api_spec" | "unit_test" | "file_body" |
"malformed_item" | "unsupported_method" | "malformed_spec" | "example_no_status" |
"default_response" | "external_ref" | "duplicate_operation_id" | "cookie_param" |
"unmapped_body" | "unresolved_base_url" | "unsupported_auth" | "path_variables" |
"url_without_raw" | "variable_metadata", count }`.
Surfaces work Vayu can't represent so the Preview can warn instead of silently dropping.
Three of the kinds are not about representability: `unsupported_method` is an operation whose
HTTP method has no `HttpMethod` (OpenAPI 3's `trace`), and `malformed_item` / `malformed_spec`
are shapes the source file got wrong - a Postman `item[]` entry that is not an object (see
[postman.md](./postman.md)), an OpenAPI path item or `parameters` list that is not what the
spec allows - stepped over so the rest of the file still imports. The two OpenAPI kinds are
counted via `ImportTally`, shared by both OpenAPI dialects: they are
structural clones, and a second copy would drift. `example_no_status` is a fourth
non-representability case: an OpenAPI response keyed `2XX` (or with a junk key) documents a
real response, but an example is served under one status line and there is no honest value
to pick, so it is counted rather than guessed at. `default_response` is the same skip for the
`default` key, on a counter of its own (issue #710) because it is conformant and declared on
nearly every operation of a vendor spec - the Preview names it as information rather than as
damage, which is what keeps a 568-count line from burying the one warning that needs acting
on. `external_ref` is the fifth, and the only
kind no parser produces: a `$ref` naming another file that the bundling pass could not
read (`ref-bundler.ts`, issue #649) is counted **before** parse and stamped into
`meta.skipped` by `parseImport`, one per reference - because each one is an operation that
imported without the schema it declared. `duplicate_operation_id` is the sixth, and the only
one where nothing is dropped from the request itself: an `operationId` a document declares
twice is kept on the first operation and left off the second, whose recorded identity then
rests on its method and templated path alone (issue #715). Counted per repeated declaration,
because a sync follows the identity a request records, and which of the two kept the id is
not something the user should have to work out from a diff.

The last three are OpenAPI 3 kinds added by issue #719, each closing a drop that had no
counter at all. `cookie_param` is a parameter declared `in: "cookie"`: Vayu's cookies come
from the jar, and folding one declaration at a time into a single joined `Cookie` header
would mean inventing a merge the document never wrote, so mapping them is a recorded
non-goal and naming the loss is the honest half. `unmapped_body` is a `requestBody`
declaring only media types with no Vayu mode - `application/octet-stream`,
`application/xml`, `image/*` - which used to return `{ mode: "none" }` on the same path as
*no body at all*, so a binary upload imported as a bodyless POST reporting nothing skipped;
an operation that declared no body is still not counted, because it lost nothing.
`unresolved_base_url` is a `servers[0].url` that could not be made into an address a request
could reach - a `{variable}` the document declares no default for, or a relative URL in a
document that arrived with no URL to resolve it against (see
[OpenAPI 3.0](./openapi-v3.md#the-base-url)).

The last four are Postman kinds added by issue #1443, closing gaps in the same "dropped is
counted" promise. `unsupported_auth` is an `auth.type` Postman defines and Vayu has no mode
for (`hawk`, `oauth1`, `edgegrid`, or a non-string `type`), unlike `awsv4`/`digest`/`ntlm`,
which import as data and count under `nonExecutableAuth` instead. `path_variables` and
`url_without_raw` are not losses: the first counts a request whose `url.variable[]` path
segment was turned into a `{{key}}` template plus a collection variable, the second a URL
assembled from `host[]`/`path[]` because it carried no `raw` - both are mappings the Preview
should say happened, not damage, so like `default_response` they sort into the informational
half of the notice list rather than the destructive one. `variable_metadata` is a collection,
folder, environment or globals variable whose `description` or a meaningfully declared `type`
(anything but `secret` or Postman's own `default` marker) was read and discarded, because
Vayu's variable record has a field for the value and the secret flag only (see
[postman.md](./postman.md#variables-environments)).

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

Reusable mapping rules, shared between the formats that need them. All of them
live in `engine/src/core/import_document.cpp` unless noted; the two the OpenAPI
dialects use - `normalize_path_templates` and the sampler - are
`engine/src/core/path_template.cpp` and `engine/src/core/openapi_drafts.cpp`.
The names below are those functions'.

### as_string
`as_string(v)` - coerces any scalar to its string form; objects are `JSON.stringify`-d;
`null`/`undefined` → `""`. Vayu stores all values as strings. 

### to_var_record
`to_var_record(vars)` - Postman/Insomnia variable arrays (`{key, value?, enabled?, disabled?}`)
→ `Record<string, VariableValue>`. `disabled` takes precedence over `enabled`; default
`enabled: true`. Values pass through `normalize_template_vars`. Rows without a `key` are skipped.

### map_key_values
`map_key_values(rows)` - Postman header/query/urlencoded arrays → `KeyValueEntry[]`. Sets
`enabled = r.disabled !== true`, normalizes each value, carries `description` when present,
and **preserves duplicates and disabled rows**. 

### map_postman_auth
`map_postman_auth(auth)` - a Postman `auth` object (collection / folder / request) → `RequestAuth`.
Reads the per-type detail via `auth_detail`, which handles both v2.1's array shape
(`[{key, value}]`) and v2.0's object shape. Maps `bearer`/`basic`/`apikey` to concrete auth,
maps `oauth2` to an **executable** `{mode:"oauth2", config}` via `map_postman_oauth2` (below),
stores `digest`/`aws`/`ntlm` as `{mode, config}` (not executed), maps the real AWS wire type
`awsv4` → the internal `{mode:"aws", config}`, `noauth` → `none`, and missing/`inherit` →
`inherit`. A collection/folder `noauth` is handled by `collection_auth` instead,
which maps it to the terminal `{mode:"noauth"}`. 

### OAuth 2.0 mapping
Turns each source format's OAuth 2.0 block into Vayu's typed `OAuth2Config`, so imported
OAuth 2.0 auth is **executable** (not a passive `{mode, config}` bag):
- `map_postman_oauth2(detail)` - Postman v2.1 `oauth2` params, incl. grant normalization
  (`authorization_code_with_pkce` → auth-code + PKCE; `implicit` → auth-code + PKCE; a minimal
  export with only a pre-fetched `accessToken` → a bearer token).
- `map_insomnia_oauth2(auth)` - Insomnia's camelCase `oauth2` object.
- `map_openapi_v3_oauth2(scheme)` / `map_swagger_oauth2(scheme)` - pick the first usable flow from an
  OpenAPI v3 / Swagger v2 `oauth2` security scheme (client id/secret seeded as `{{variables}}`).

Grant/field normalization is shared here so the parsers agree. Only `digest`/`aws`/`ntlm`
remain non-executable and are counted in `meta.nonExecutableAuth`.

### raw_body
`raw_body(content, language)` - Postman raw body → `RequestBody`. `json`/`text`/`xml` map
directly; with no explicit language it sniffs via `JSON.parse` (success → `json`, else
`text`) and never guesses `xml`.

### join_exec
`join_exec(event)` - a Postman event entry → a single script string. Joins
`event.script.exec[]` with `\n` (or returns a string `exec` as-is). 

### normalize_template_vars / normalize_path_templates
`normalize_template_vars(text)` - normalizes foreign template syntax to Vayu `{{var}}`:
`{{ x }}` / `{{ _.x }}` → `{{x}}` (trimmed, `_.` prefix stripped). Its sibling
`normalize_path_templates(path)` additionally rewrites single-brace `{x}` → `{{x}}` (without
touching an existing `{{…}}` pair); **only the OpenAPI/Swagger paths call it**, because in
Postman and Insomnia a single brace is literal text (`/tags/{beta}`, `fields=friends{name}`)
and rewriting it invents a variable reference that resolves to nothing. Nunjucks tags
`{% … %}` and filtered vars `{{ x | filter }}` are left **verbatim** - Vayu has no equivalent
and renders them as literal text. 

### Dynamic variables in imported collections

Postman and Bruno collections routinely contain `{{$guid}}`, `{{$timestamp}}`
and the `{{$random*}}` faker names. The parse passes them through untouched -
`normalize_template_vars` only trims and strips a `_.` prefix - and **they now resolve**
at send time from the generator table described in
[variable resolution](../variable-resolution.md#dynamic-variables). Before that
table existed they resolved to an empty string, so an imported request whose
body carried a `{{$guid}}` sent an empty field and the import looked successful.

A `$name` outside the supported set is left written as `{{$name}}` in the
outgoing request rather than emptied, so an imported collection using a faker
value Vayu does not have shows it instead of hiding it.

### Sampler::sample
`Sampler::sample(schema)` - generates a sample value for an OpenAPI/Swagger schema,
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

(the sampler, `engine/src/core/openapi_drafts.cpp`)

---

## Adding a new format

All of it is engine-side (`engine/src/core/import_document.cpp`); nothing in
`app/src` needs to change, and the dialog picks the new format up for free.

1. Write the parse in `import_document.cpp`, emitting the draft model above (no
   ids, no persistence). Reuse what is there - `map_key_values`, `to_var_record`,
   `imported_file_part`, `with_required_content_type`, the OAuth mappers - rather
   than a second copy of a rule; the JavaScript semantics the drafts are held to
   (`js_json.hpp`) are shared with the OpenAPI builder for the same reason.
2. Add its detector to `parse_import`'s chain at the correct
   **most-specific-first** position, so it does not shadow (or get shadowed by)
   another format.
3. Populate `meta.skipped` / `meta.nonExecutableAuth` for anything Vayu cannot
   execute or represent, and let `unattached_file_parts` count uploads the user
   still has to attach, so the Preview can warn them. A loss the preview never
   names is the defect this whole subsystem is organised around.
4. Add cases to `engine/tests/fixtures/import-conformance.json` and register the
   suite the way `engine/tests/CMakeLists.txt` requires.
5. Add a `docs/app/import-collections/<format>.md` following the structure of the
   existing per-format docs, and a row in the table at the top of this file.
