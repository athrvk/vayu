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
difference is what applying a sync will do.

## Checking a bound spec for changes

A contract moves. The **Sync** section of the Spec tab re-reads the bound
document and tells you what moved - and, for now, only tells you: **checking
writes nothing at all**, so it costs nothing to ask.

Where it re-reads from is what the binding recorded:

| The spec was… | Checking re-reads it… |
|---|---|
| Fetched from a URL | From that URL |
| Picked as a file | From that file, in the desktop app, on the machine that picked it |
| Pasted, or picked on another machine | Not at all - it says so, and offers binding again |

What comes back is bundled exactly as an import bundles it, so a spec written
across several files is compared as the same one document that was stored. If it
is **byte for byte** what the collection is bound to, the answer is "up to date"
and nothing further is computed.

### The three buckets

Otherwise the difference is reported by **operation identity** - the
`operationId`, method and templated path each request recorded when it was
bound:

- **New operations** the document declares that no request in this collection is.
- **Operations the document no longer declares**, listed by the request that
  still claims them. Those requests are not going anywhere; they are simply no
  longer described by the contract.
- **Changed** - the request is still that operation, and one or more of the
  fields an import writes (name, description, URL, params, headers, body) is no
  longer what the document produces.

Everything else is counted as unchanged, and requests carrying no operation at
all are counted separately: the contract never described them, so the comparison
leaves them out and says how many it left out.

### Renames, and what is never guessed

An operation that moves is followed rather than reported as a deletion and an
addition:

- A **path that changed** under a stable `operationId` follows the `operationId`.
- An **`operationId` that changed** under a stable path follows the path. A
  renamed path *parameter* - `/pets/{petId}` to `/pets/{id}` - is the same
  endpoint, the same rule binding uses.
- **Both changed at once** is reported as one operation gone and one arrived,
  because there is nothing left to follow, and a wrong identity is what would
  make a later apply rewrite the wrong request.

### What you edited is marked as yours

A changed field is marked **edited here** when what the request holds is neither
what the new document produces *nor* what the bound one did. That is the only
evidence that a person put it there, and it is what stops applying a sync from
quietly reverting your work. When the bound document itself cannot be read, the
section says so for that request instead of guessing which side a difference came
from.

**Saved response examples are not compared yet.** Which of them a sync may
replace - the ones an import created, never the ones you saved - is decided
where a sync applies changes, so they are compared there.

## What is not here yet

Applying what a check found, validating responses against their declared
schemas, contract coverage on a run report, and export back out to an OpenAPI
document. Each is its own phase; this page grows with them.
