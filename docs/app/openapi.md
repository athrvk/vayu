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
  what was stored and a later re-fetch is compared against it. A spec written
  across several files is the one exception - see
  [Specs written across several files](#specs-written-across-several-files).
- A **fetched URL is kept**, so the document knows where it came from.
- Every request created from an operation records that operation's
  `operationId` (when the document declares one), its method, and its
  **templated** path - `/pets/{petId}`, not the URL the request sends.

Other formats are unaffected. A Postman or Insomnia import binds nothing and
records no operation identity: those files describe requests, not a contract.

## Specs written across several files

A large document is usually not one document: schemas live in their own files,
shared errors in another, and the entry point names them with references like
`./schemas/pet.yaml#/Pet`. Vayu **follows those references before it parses**,
inlines what they name, and imports the result as one document.

Where a referenced file is read from depends on where the spec came from:

| The spec was… | A relative reference is read… | An absolute `https://` reference |
|---|---|---|
| Fetched from a URL | From that URL's directory | Fetched |
| Picked as a file | From beside the file, on this machine | Fetched |
| Pasted as text | Not at all - there is no directory to read from | Fetched |

References are followed through the files they lead to, so a file that refers to
a third is resolved too, and a cycle stops rather than looping. Each file is read
once however many references name it.

**What cannot be read is said, never silently dropped.** A file that is missing,
unreachable, or not valid JSON or YAML leaves its reference exactly as the
document wrote it, and the import preview counts it - one per reference, because
each one is an operation that imported without the schema it declared. Before
this, such a reference simply produced an empty body stub and no message at all.

Reading a file beside a picked spec is the only part of this that touches the
disk. It goes through the same kind of gate the [data
contract](data-driven-runs.md) uses for its files: only `.json`, `.yaml` and
`.yml`, only paths resolved in the desktop process from the document you picked,
and nothing larger than the engine's `maxSpecDocumentBytes`.

**A multi-file spec is stored as the bundle** - the entry document with the
others inlined - and not as the entry file alone. There is no single verbatim
text for a spec that is several files, and storing only the entry would store a
document naming files nothing else can reach. The bundling is deterministic, so
the same spec always produces the same bytes and the same hash. A single-file
spec is untouched.

If the whole bundle would exceed `maxSpecDocumentBytes`, the import stops and
says so rather than storing a truncated contract.

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

## Export - back out to a document

Any collection exports as an OpenAPI document, from its ⋯ menu in the sidebar or
from the **Export as OpenAPI** button on the Spec tab. The document is assembled
here, from what is stored, and written to a file you choose the format of - JSON
or YAML, the same document either way. Nothing is sent anywhere.

**Which of two things happens depends on whether the collection is bound**, and
the dialog says which before you download.

### A bound collection exports its own document, updated

The document Vayu stored is the one that comes back out - parsed, changed where
Vayu has something to say, and otherwise left exactly as it was:

- **Operations follow the collection.** An operation the document declares that
  no request here claims is removed, and a path left with no operations goes with
  it. A request with no operation identity is *not* added: the contract never
  described it, and a document must not gain an endpoint from a request that was
  never one. Those requests are counted in the dialog, and binding or matching
  them is how they get an identity.
- **Values become examples.** A declared parameter whose Params or Headers row
  carries a value gets that value as its `example`. A blank row writes nothing -
  an import creates blank header rows, and a blank one deleting what the document
  documented would lose the contract to a row nobody typed in. A `$ref`
  parameter is never touched: it belongs to every operation that names it.
- **Saved examples become response examples**, whether they came from the import
  or from a response you kept. One example for a status and media type is written
  as `example`, several as a named `examples` map. This is where work done in
  Vayu flows back into the contract.
- **Everything else survives.** Vendor extensions, `info`, `tags`, `security`,
  components nothing references - all of it is carried through, because export
  patches the document rather than rebuilding it. The dialect is left alone too:
  a 3.0 document exports as 3.0, never quietly upgraded.

A **Swagger 2.0** document is the one partial case, and it is stated as one:
operations nothing claims are still removed, but nothing is written *into* an
operation. 2.0 states parameters and examples in a different vocabulary, and
half a translation is a file that is neither dialect.

If the stored document cannot be read at all, the export stops and says so. It
does not fall back to the skeleton below - that would silently replace the
document you meant to update with one that drops everything Vayu does not model.

### A free-form collection exports a skeleton

A collection that was never a spec has no document to update, so it gets a new
one - **a starting point, not a contract**, and the dialog says exactly that.
Everything in it is something the collection actually holds:

- `info.title` is the collection's name. Its `version` is a placeholder
  (`0.0.0`), because a collection records no version and inventing one would read
  like a release.
- **`servers` and paths keep your variables.** A URL beginning `{{baseUrl}}`
  exports a server of `{{baseUrl}}`, verbatim. That is the portable form - it is
  what an import writes back into a URL - and resolving it would bake one
  machine's environment into a document meant to be shared.
- **Path parameters are recovered.** A segment that is exactly one token -
  `/pets/{{petId}}` - is the OpenAPI `/pets/{petId}` it came from, declared as a
  required path parameter. A token inside a longer segment is left as it is:
  OpenAPI has no syntax for part of a segment.
- **Rows are declared, not interpreted.** Every Params and Headers row becomes a
  parameter, disabled ones included - the endpoint accepts them either way - and
  none of them is marked `required`, because a toggle is what this request sends,
  not what the API demands. `Authorization` and `Content-Type` are left out, the
  two an import also drops.
- **No schema Vayu did not see.** A request or response body is described only
  where there is a body to read a shape off, and what is written is the shape of
  that one example - types, nothing more - carrying a `description` that says so.
  An operation with no saved example documents no response at all, rather than an
  invented `200 OK`.

### What the counts mean

Both directions state what they could not carry, and the zeros are part of the
statement: a request whose URL states no path, two requests that reduce to the
same method and path (the first wins), an example whose media type was never
recorded (the response is written, the body is not). Nothing is dropped quietly.

## What is not here yet

Re-fetching a bound document and applying its changes, validating responses
against their declared schemas, and contract coverage on a run report. Each is
its own phase; this page grows with them.
