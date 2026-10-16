---
description: >-
  What carries over when you import an Insomnia v5 YAML export into Vayu - a collection or an environment document from Insomnia 11 and later - and what Vayu refuses by name.
---

# Insomnia v5

Reads the YAML document Insomnia 11 and later write when you export a collection or an environment (`type: collection.insomnia.rest/5.x` or `environment.insomnia.rest/5.x`). v5 nests where [v4](./insomnia-v4.md) listed: a collection is a `collection[]` tree whose folders hold `children`, and its environments sit in an `environments` object. Vayu reads that tree **through the v4 mapping**, so the rest of this page is short on purpose - a request, its body, its auth and its environments become the same drafts a v4 export of the same workspace produces, and only `meta.format` tells the two apart.

- **Source:** `engine/src/core/import_document.cpp` (`InsomniaV5Flattener`, then `parse_insomnia_resources`, which v4 shares)
- **`meta.format`:** `Insomnia Export v5`, for a collection document and an environment document alike
- **Reader:** the engine's one reader, behind [`POST /import/parse`](../../engine/api-reference.md#post-importparse). A v5 document is YAML in practice, and the same reader takes a JSON-encoded copy of one.

> **The field spellings on this page are assumed.** They come from Insomnia's v5 schema, not from a real export checked against this reader. A member that a real export spells differently reads as **absent**: the request imports without it, with no error. See [Assumed field spellings](#assumed-field-spellings-not-yet-checked-against-a-real-export) for the full list.

## Detection

A document is claimed as Insomnia v5 when it has a string `type` member of the shape `<kind>.insomnia.rest/<version>`:

| `type` | Outcome |
|--------|---------|
| `collection.insomnia.rest/5` or `/5.x` | Imported as a collection. |
| `environment.insomnia.rest/5` or `/5.x` | Imported as environments only. |
| `spec.insomnia.rest/…` (a design document) | **Refused by name.** |
| `mock.insomnia.rest/…` (a mock server) | **Refused by name.** |
| any other kind, such as `mcpClient.insomnia.rest/…` | **Refused by name.** |
| `collection` or `environment` in any version other than 5 | **Refused by name**, saying which format version it is. |

Any `5.x` revision reads, so a minor revision of the format is not refused for its number alone. A `type` member that does not carry the `.insomnia.rest/` marker is not an Insomnia document and falls through to the later formats.

Detection runs after [Insomnia v4](./insomnia-v4.md) and before OpenAPI; see [the detection order](./README.md#pipeline-overview).

### Refusals

A document Vayu does not read is refused with a sentence that says what the file is, rather than "Unrecognised format" - a design document or a mock server is a file you may well have picked believing it to be your collection. The sentence starts `Could not read the document: this is an Insomnia …` and the import dialog shows it as written. Nothing is imported.

| Document | Sentence (after `Could not read the document: `) |
|----------|--------------------------------------------------|
| design document | `this is an Insomnia design document (spec) export, which Vayu does not read. Export the collection instead.` |
| mock server | `this is an Insomnia mock server export, which Vayu does not read. Export the collection instead.` |
| another kind | `this is an Insomnia <kind> export, which Vayu does not read. Export the collection instead.` |
| another format version | `this is an Insomnia collection export in format <version>, which this version of Vayu does not read. It reads format 5.` (`environment` for an environment document) |

## What carries over

The flattener rewrites the v5 tree into v4's flat resource list and the v4 reader maps it, so each rule below is the v4 rule:

| v5 | Vayu | Mapping |
|----|------|---------|
| the document (`name`, `description`) | the root `CollectionDraft` | name falls back to `"Imported"`, as in v4 |
| `collection[]` item with `children` | a nested collection (folder) | counts in `folderCount`; its `description`, `authentication` and scripts are read |
| `collection[]` item with a `url` or `method` | a `RequestDraft` | [Request field mapping](./insomnia-v4.md#request) |
| `body` | the request body | [Body mapping](./insomnia-v4.md#body-mapping) |
| `authentication` | the request's (or folder's) auth | [Auth mapping](./insomnia-v4.md#auth-mapping) |
| `headers`, `parameters`, `pathParameters` | header rows, query rows, path rows | [Request field mapping](./insomnia-v4.md#request), including the [url/params invariant](./README.md#the-urlparams-invariant) |
| `scripts.preRequest`, `scripts.afterResponse` | the pre-request and post-request script | read as v4's `preRequestScript` / `afterResponseScript`; honors `importScripts` |
| `settings.followRedirects` | `followRedirects` | a boolean reads as `on` / `off`; v4's string values read as in v4 (`global` or absent leaves the engine default) |
| `description`, or `meta.description` | `description` | the first that is present |
| `environments` | `EnvironmentDraft`s | [Environments](./insomnia-v4.md#environments): a base environment with sub-environments imports as one environment per sub-environment, base values merged in; honors `importEnvironments` |

Variable references go through the same [template normalization](./insomnia-v4.md#template-normalization): `{{ _.x }}` becomes `{{x}}`, and Nunjucks tags and filtered expressions stay literal text.

### Environment documents

An `environment.insomnia.rest/5.x` document imports **environments only**, under `importEnvironments` exactly as a [Postman environment](./postman-environment.md) export does: `collections` is empty, and with the option off nothing is created. The document's own `name` names the environment, and the base environment's own `name` is ignored in an environment document (a collection document keeps it). A document with no `name` either imports its environment as "Environment". With sub-environments, each imports under its own name with the base values merged in beneath it, as in a collection.

## What is not imported

| In the document | Outcome |
|-----------------|---------|
| a gRPC item | Dropped and counted in `meta.skipped` as `grpc`. |
| a WebSocket item | Dropped and counted in `meta.skipped` as `websocket`. |
| any other `collection[]` item that is not a folder and has neither `url` nor `method` | Dropped silently, not counted. An item with no `children` is still a folder when its `meta.id` starts with `fld_`. |
| `cookieJar` | Not imported. |
| `certificates` | Not imported. |
| a folder's `headers` and `environment` | Not imported - the v4 reading has no place for either on a folder. |
| a top-level member other than `name`, `description`, `collection` and `environments` | Not read. |
| `meta.id` and every other id | Not carried; the reader mints its own so that a hand-edited file with repeated ids cannot tangle the tree. |
| Nunjucks tags, filtered expressions | Kept as literal text. |
| a per-request redirect limit, and every `settings` member except `followRedirects` | Not read; see [Options & lossy behavior](./insomnia-v4.md#options--lossy-behavior). |

A gRPC item is recognised by its `protoFileId` or `protoMethodName` member or a `greq_` id prefix on `meta.id`; a WebSocket item by a `ws://` or `wss://` URL or a `ws-req_` id prefix. Both guesses are assumed (below), and a misread one imports as an HTTP request or is dropped without being counted.

The skip tally, `file_body` for a binary body, and `nonExecutableAuth` for `digest` / `ntlm` / `iam` all work as in v4, because they are the v4 code.

## Malformed documents

A present member of the wrong shape fails the import with `Malformed Insomnia export: <detail>`, shown verbatim by the dialog; an **absent** member is never an error. v5 nests, so the detail names the field by its path:

| Input | Detail |
|-------|--------|
| `collection` present but not an array | `` `collection` must be an array `` |
| a `collection[]` entry that is not an object | `` `collection[<i>]` must be an object `` |
| a folder's `children` present but not an array | `` `collection[<i>].children` must be an array `` |
| `environments` present but not an object | `` `environments` must be an object `` |
| `environments.subEnvironments` present but not an array | `` `environments.subEnvironments` must be an array `` |
| a sub-environment that is not an object | `` `environments.subEnvironments[<i>]` must be an object `` |

The row-shape errors v4 raises for `parameters`, `headers` and `body` apply unchanged; see [Malformed exports](./insomnia-v4.md#malformed-exports).

## Assumed field spellings, not yet checked against a real export

Every v5 member the reader consumes is taken from Insomnia's v5 schema. **None of them has been checked against a real Insomnia 11 export**, so this list is the page's honest edge. A member spelled otherwise reads as absent, and the first real export that disagrees is a one-line fix in `InsomniaV5Flattener`.

- **Document:** `type`, `name`, `description` (or `meta.description`), `collection` (the item list), `environments`.
- **Item, any kind:** `name`, `description` or `meta.description`, `meta.id` (read for the folder, gRPC and WebSocket id prefixes only).
- **Folder:** `children` (its presence is what makes an item a folder), or, for an empty folder written without it, a `fld_` prefix on `meta.id` and no `url` or `method`; `authentication`, `scripts.preRequest`, `scripts.afterResponse`.
- **Request:** `url`, `method`, `headers`, `parameters`, `pathParameters`, `body`, `authentication`, `scripts.preRequest`, `scripts.afterResponse`, `settings.followRedirects`. Rows and bodies are assumed to keep v4's inner shape (`name` / `value` / `disabled`, `body.mimeType` / `text` / `params`).
- **gRPC / WebSocket detection:** `protoFileId`, `protoMethodName`, the `greq_` and `ws-req_` id prefixes in `meta.id`, and a `ws://` / `wss://` URL.
- **Environments:** `environments.name`, `environments.data`, and `environments.subEnvironments[]` with `name` and `data` each. That an environment document's own `name` is the name the user gave it, and its base environment's `name` is not, is also assumed: Insomnia's actual naming of the base was not checked.

## Related

- [Importers overview](./README.md)
- [Insomnia v4](./insomnia-v4.md) - the mapping this page defers to
- [Postman Environment and Globals](./postman-environment.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2 (Swagger)](./openapi-v2.md)
