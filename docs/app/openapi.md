# OpenAPI Collections

A collection can be **bound** to an OpenAPI document: the spec is stored with
the workspace, the collection records which document and which version it
answers to, and each request records which operation it is.

Importing a spec has always produced requests. Binding is what keeps the
contract afterwards - and it is what later phases build on, because
"re-fetch and show me what changed", "did this response match its schema" and
"which operations did this run exercise" all need to know which request is which
operation.

Vayu **consumes** contracts. There is no spec editor, and binding never rewrites
a document.

## What gets stored, and where

| Thing | Where it lives | Travels between machines |
|---|---|---|
| The document itself | Engine, one row in `spec_documents`, hashed on write | Yes |
| The binding (`specId`, `specHash`, `syncedAt`) | Engine, on the collection | Yes |
| The operation each request is | Engine, on the request | Yes |
| The URL it was fetched from | Engine, `spec_documents.source_url` | Yes |
| A picked file's path on disk | This machine only, renderer storage | No |

The split is the same one the [data contract](data-driven-runs.md) follows: a
path is true of one filesystem, so it never reaches the engine, an export or the
MCP server. Only the path and the file's name are kept locally - the document's
contents are on the engine, where they can be hashed and compared.

Several collections may bind the same document. It is not owned by any of them,
which is why unbinding one leaves it in place, and why the engine refuses to
delete a document while a collection still binds it.

## Binding on import

Import an OpenAPI 3.x or Swagger 2.0 document the usual way -
[Import Collections](import-collections/README.md) - and the collection it
creates is bound automatically:

- The document is stored **verbatim**, exactly the bytes that were read. A
  YAML spec stays YAML; nothing is re-serialized, because the hash is taken of
  what was stored and a later re-fetch is compared against it.
- A **fetched URL is kept**, so the document knows where it came from.
- Every request created from an operation records that operation's
  `operationId` (when the document declares one), its method, and its
  **templated** path - `/pets/{petId}`, not the URL the request sends.

Other formats are unaffected. A Postman or Insomnia import binds nothing and
records no operation identity: those files describe requests, not a contract.

## The Spec tab

A collection's **Spec** tab shows the binding and is where one is made or
removed.

**Bound** shows where the document came from (its URL, or the file name if this
machine is the one that picked it), the first characters of its hash, when it
was fetched and when it was bound, and how many of the collection's requests -
across its whole subtree - carry an operation identity.

**Unbind** clears the binding and nothing else. The requests stay, their
recorded operations stay, and the document stays for whatever else binds it.

## Binding a collection you already have

The tab also binds a collection that was not imported from a spec. Pick a file
or fetch a URL, and Vayu matches the document's operations against the requests
already there:

- Matching is by **method and path shape**. The origin, the query and the
  fragment are dropped, and every placeholder - Vayu's `{{petId}}` and the
  document's `{petId}` - is flattened, so a renamed path parameter still matches.
- A request with the id **written in** (`/pets/42`) matches `/pets/{petId}`, as
  long as no literal path in the document claims it first.
- **Ambiguity is refused.** If two requests reduce to the same path, or one
  request could be two operations, none of them is matched.

The result is stated before anything is written - how many matched, how many
requests carry no operation, how many operations have no request - and only the
matches are stamped. **Nothing is created, deleted or rewritten**: acting on the
difference is what syncing a changed spec will do, and it needs a diff this
phase does not draw.

## What is not here yet

Re-fetching a bound document and applying its changes, validating responses
against their declared schemas, contract coverage on a run report, and export
back out to an OpenAPI document. Each is its own phase; this page grows with
them.
