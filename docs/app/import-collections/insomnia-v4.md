# Insomnia v4

Parses an Insomnia "Export v4" JSON document into the Vayu draft model. Insomnia exports are a single flat array of typed resources joined by `_id`/`parentId`; the parser reconstructs the workspace → request_group → request tree and emits one root collection per workspace.

- **Source:** `app/src/services/importers/insomnia-v4.ts`
- **Exports:**

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `InsomniaV4Parser` | `Insomnia Export v4` | `insomnia-v4` |

  Implements `ImportParser` (`detect` + `parse`) from `./types`. `meta.format` is set to `this.formatName` (`"Insomnia Export v4"`).

## Detection

```ts
detect(parsed) => parsed._type === "export" && parsed.__export_format === 4
```

Both conditions must hold: the top-level object must have `_type === "export"` and `__export_format === 4` (numeric). No other format versions are accepted by this parser.

## Structure & tree reconstruction

An Insomnia v4 export has the shape `{ _type: "export", __export_format: 4, resources: Resource[] }`. Each resource carries `_id`, `_type`, an optional `parentId`, and type-specific fields. There is no nesting in the JSON - hierarchy is expressed entirely through `parentId` references.

Reconstruction steps in `parse()`:

1. **Index by parent.** Build `byParent: Map<parentId, Resource[]>`, grouping every resource under its `parentId` (resources with no `parentId` use the empty-string key `""`). This is the single adjacency index used for the whole tree walk.
2. **Find roots.** Filter `resources` for `_type === "workspace"`. Each workspace becomes one root `CollectionDraft`. Multiple workspaces ⇒ multiple root collections in `ImportResult.collections`.
3. **Recursive build.** `buildCollection(node, isWorkspace)` walks `byParent.get(node._id)` and dispatches each child by `_type`:
   - `request_group` → increments `folderCount`, recurses via `buildCollection(child, false)`, pushed to `children`.
   - `request` → `buildRequest(child)`, pushed to `requests`.
   - other handled `_type`s (gRPC / WebSocket / spec / tests) → counted in `skippedCounts` (see [Resource type handling](#resource-type-handling)).
   - any unlisted `_type` (including `environment`) → silently ignored by the collection walk; environments are processed separately.
4. `buildRequest(r)` increments `requestCount` and produces a `RequestDraft`.

Key internal functions: `parse` (entry), `buildCollection`, `buildRequest`, `insomniaAuth`, `insomniaBody`, `toEnvVars`. Counters (`requestCount`, `folderCount`, `authCtx.nonExec`) are closures mutated during the walk.

## Resource type handling

| Insomnia `_type` | Vayu outcome | Notes |
|------------------|--------------|-------|
| `workspace` | Root `CollectionDraft` | One per workspace. `isWorkspace = true`. |
| `request_group` | Nested `CollectionDraft` (folder) | Increments `folderCount`. |
| `request` | `RequestDraft` | Increments `requestCount`. |
| `environment` | `EnvironmentDraft` (flattened) | Processed in a separate pass, not in the collection walk. Gated by `importEnvironments`. See [Environments](#environments). |
| `grpc_request` | **Dropped** | `meta.skipped` kind `"grpc"`. |
| `websocket_request` | **Dropped** | `meta.skipped` kind `"websocket"`. |
| `api_spec` | **Dropped** | `meta.skipped` kind `"api_spec"`. |
| `unit_test` | **Dropped** | `meta.skipped` kind `"unit_test"`. |
| `unit_test_suite` | **Dropped** | `meta.skipped` kind `"unit_test"` (folded into the same `unit_test` bucket). |
| anything else (e.g. `cookie_jar`, `proto_file`, `request_meta`, `environment` outside its pass) | **Dropped silently** | Not counted in `meta.skipped`. |

**Skip counting nuance.** Only the five `_type`s listed above (`grpc_request`, `websocket_request`, `api_spec`, `unit_test`, `unit_test_suite`) are tallied in `skippedCounts`, and only when they appear as a **direct child of a workspace or request_group** during the tree walk. A dropped resource parented under something else (or any other `_type`) does not increment `meta.skipped`. When emitting `SkippedItem[]`, the raw keys are remapped: `grpc_request → "grpc"`, `websocket_request → "websocket"`, `unit_test_suite → "unit_test"`; `unit_test` and `api_spec` pass through unchanged. Because `unit_test` and `unit_test_suite` both map to `"unit_test"` but are aggregated by their raw key first, an export containing both can yield **two** separate `SkippedItem` entries with `kind: "unit_test"`.

## Field mapping

### Collection (workspace / request_group)

Both build through `buildCollection`. Differences are gated by `isWorkspace`.

| Insomnia field | Vayu `CollectionDraft` field | Notes |
|----------------|------------------------------|-------|
| `name` | `name` | Falls back to `"Imported"`. |
| `description` | `description` | Falls back to `""`. |
| `environment` (object, workspace only) | `variables` | `toEnvVars(node.environment ?? {})` for workspaces; **request_groups always get `variables: {}`** (their inline environment, if any, is not read). |
| `authentication` | `auth` | Mapped via `insomniaAuth`. Collections may not be `inherit`: a resulting `inherit` is coerced to `{ mode: "none" }`. |
| - | `preRequestScript` / `postRequestScript` | Always `""` for collections (workspace/group-level scripts are not imported). |
| (reconstructed children) | `children` / `requests` | Built from `byParent`. |

### Request

Built by `buildRequest`.

| Insomnia field | Vayu `RequestDraft` field | Notes |
|----------------|---------------------------|-------|
| `name` | `name` | Falls back to `"Untitled"`. |
| `description` | `description` | Falls back to `""`. |
| `method` | `method` | Upper-cased; restricted to `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`, otherwise defaults to `GET`. |
| `url` | `url` | `normalizeVars(asString(url))`. |
| `parameters[]` (`{name,value,disabled}`) | `params` | `mapKeyValues`: `name → key`, `disabled !== true → enabled`. Rows without a `key` are dropped. |
| `headers[]` (`{name,value,disabled}`) | `headers` | Same mapping as params. |
| `body` | `body` | Via `insomniaBody`. See [Body mapping](#body-mapping). |
| `authentication` | `auth` | Via `insomniaAuth`. See [Auth mapping](#auth-mapping). |
| `preRequestScript` | `preRequestScript` | Only if `opts.importScripts`; else `""`. |
| `afterResponseScript` | `postRequestScript` | Only if `opts.importScripts`; else `""`. Note the source field is `afterResponseScript`. |
| `_id` | - | Not propagated to the draft `id`; used only for tree reconstruction. |

`mapKeyValues` runs `normalizeVars` over every value and preserves duplicate keys and order.

## Template normalization

All variable-bearing strings are run through `normalizeVars` (`var-normalize.ts`). It converts foreign template syntax to Vayu's `{{var}}` form:

- `{{ x }}` and `{{ _.x }}` (identifier only, whitespace tolerant) → `{{x}}`. The leading `_.` namespace Insomnia uses is stripped.
- OpenAPI single-brace `{x}` → `{{x}}`, but only when not already part of a `{{...}}` pair (it checks the adjacent characters). This rule is shared with the OpenAPI parsers and rarely fires on Insomnia input.
- **Left verbatim:** Nunjucks tags `{% ... %}` and filtered expressions `{{ x | filter }}`. The simple-var regex requires an identifier-only body (`[\w.$-]+`), so a `|` filter never matches and is passed through unchanged. Vayu has no equivalent, so these remain as literal text.

Applied to: request `url`; every `params` and `headers` value (inside `mapKeyValues`); JSON/text/graphql body `content` and urlencoded/form-data field values; every auth token/username/password/key/value string; and every environment value (inside `toEnvVars`).

## Body mapping

`insomniaBody` keys off `body.mimeType`, stripping any `;charset=...` suffix and trimming.

| Insomnia `body.mimeType` | Vayu `RequestBody` | Notes |
|--------------------------|--------------------|-------|
| `application/json` | `{ mode: "json", content }` | `content = normalizeVars(body.text)`. |
| `text/plain` | `{ mode: "text", content }` | `content = normalizeVars(body.text)`. |
| `application/graphql` | `{ mode: "graphql", content }` | `content = normalizeVars(body.text)`. |
| `application/x-www-form-urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `body.params[]` → `mapKeyValues` (`name → key`, `disabled` honored). |
| `multipart/form-data` | `{ mode: "form-data", fields }` | `body.params[]` **filtered to drop entries where `type === "file"`**, then `mapKeyValues`. File parts are silently discarded - note this is **not** recorded in `meta.skipped` (no `"file_body"` item is emitted by this parser). |
| anything else, missing, or empty | `{ mode: "none" }` | Includes raw/binary/file-only bodies. |

## Auth mapping

`insomniaAuth(authentication, ctx)`:

| Insomnia `authentication.type` | Vayu `RequestAuth` | `nonExecutableAuth`? |
|--------------------------------|--------------------|----------------------|
| (absent / no `type`) | `{ mode: "inherit" }` | no |
| any type with `disabled === true` | `{ mode: "none" }` | no |
| `bearer` | `{ mode: "bearer", token }` | no |
| `basic` | `{ mode: "basic", username, password }` | no |
| `apikey` | `{ mode: "apikey", key, value, in }` - `in` is `"query"` when `addTo === "queryParams"`, else `"header"` | no |
| `oauth2` | `{ mode: "oauth2", config: OAuth2Config }` via `mapInsomniaOAuth2` - **executable** | no |
| `digest` | `{ mode: "digest", config }` | **yes** |
| `ntlm` | `{ mode: "ntlm", config }` | **yes** |
| `iam` | `{ mode: "aws", config }` - Insomnia names AWS IAM `"iam"`; Vayu stores it as the `aws` config bag | **yes** |
| any other / unrecognized type | `{ mode: "inherit" }` | no |

Notes:

- **`disabled` takes precedence over `type`.** If `authentication.disabled === true`, the result is `{ mode: "none" }` regardless of `type`. If `authentication` is missing or has no `type` (and is not disabled), the result is `{ mode: "inherit" }`.
- `oauth2` is mapped to an executable `OAuth2Config` (`mapInsomniaOAuth2`) and does **not** count. `digest`/`ntlm`/`iam` are stored as opaque `config` bags (the auth object with `type` and `disabled` removed) and are **not executed** by Vayu - each occurrence increments `meta.nonExecutableAuth`.
- The same `insomniaAuth` is called for **collection-level** auth (workspace/request_group), sharing the same `authCtx`. So a non-executable auth on a workspace or folder also counts toward `nonExecutableAuth`. For collections, an `inherit` result is coerced to `{ mode: "none" }` (collections can never inherit).

## Environments

Environments are imported only when `opts.importEnvironments` is true. They are reconstructed and flattened per workspace:

1. **Base environments:** `environment` resources whose `parentId` is the workspace `_id`.
2. **Sub-environments:** `environment` resources whose `parentId` is a base environment `_id`.

Flattening per base:

- **No sub-envs:** emit one `EnvironmentDraft` from the base's `data`. Name = `base.name ?? workspace.name ?? "Environment"`.
- **Has sub-envs:** emit one `EnvironmentDraft` **per sub-env**, with variables `{ ...baseVars, ...subVars }` (sub-env values override base on key collision). Name = `sub.name ?? "Environment"`. **The standalone base environment is not emitted** when sub-envs exist - its values survive only merged into each sub-env.

Each variable is produced by `toEnvVars`: keys come straight from the env `data` object; values are `normalizeVars(asString(v))` (objects/arrays are JSON-stringified, numbers/booleans coerced to strings), and every variable is `{ value, enabled: true }`. `secret` is never set. `meta.environmentCount` equals the number of emitted `EnvironmentDraft`s.

## Options & lossy behavior

`ImportOptions`:

- **`importScripts`** - when false, request `preRequestScript`/`postRequestScript` are forced to `""`. When true, they come from `preRequestScript` and `afterResponseScript`. (Collection-level scripts are always `""` regardless.)
- **`importEnvironments`** - when false, the entire environment pass is skipped; `environments` is `[]` and `environmentCount` is `0`. Workspace-level `environment` data still populates the root collection's `variables` independently of this flag.

Lossy / dropped, summary:

- gRPC, WebSocket, API spec, unit test, and unit-test-suite resources are dropped and counted in `meta.skipped` (only when encountered as direct children of a workspace/request_group during the tree walk; see counting nuance above).
- `multipart/form-data` file parts are dropped silently - **not** reflected in `meta.skipped`.
- Non-executable auth types (`digest`, `ntlm`, `iam→aws`) are stored but not run; each occurrence (request or collection level) increments `meta.nonExecutableAuth`. `oauth2` is executable and excluded.
- Nunjucks tags and filtered template expressions are preserved as literal text.
- request_group inline environments, collection/group scripts, and resource `_id`s are not carried into the draft model.

`meta`: `{ format: "Insomnia Export v4", requestCount, folderCount, environmentCount, skipped, nonExecutableAuth }` (no `fileName` set by the parser itself).

## Shared helpers used

| Helper | Source | Used for |
|--------|--------|----------|
| `asString` | `./shared.ts` | Coerce any scalar/object to its string form (objects → `JSON.stringify`). |
| `mapKeyValues` | `./shared.ts` | Map `{name,value,disabled}` arrays → `KeyValueEntry[]` (filters keyless rows, normalizes values, derives `enabled` from `disabled`). |
| `normalizeVars` | `./var-normalize.ts` | Template syntax normalization (see [Template normalization](#template-normalization)). |

See [`./README.md`](./README.md) for the full shared-helper reference.

## Related

- [Importers overview](./README.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2 (Swagger)](./openapi-v2.md)
