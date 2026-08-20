---
description: >-
  Binding an OpenAPI document to a Vayu collection - what the spec stores, how operations map to requests, and what stays in sync.
---

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
| What the document declares (the operation index) | Engine, `spec_documents.operations` - read off the document by the engine when it stores it | Yes |
| The URL it was fetched from | Engine, `spec_documents.source_url` | Yes |
| A picked file's path on disk | This machine only, renderer storage | No |

The split is the same one the [data contract](data-driven-runs.md) follows: a
path is true of one filesystem, so it never reaches the engine, an export or the
MCP server. Only the path and the file's name are kept locally - the document's
contents are on the engine, where they can be hashed and compared.

Several collections may bind the same document. It is not owned by any of them,
which is why unbinding one leaves it in place, and why the engine refuses to
delete a document while a collection still binds it.

Because nothing owns a document, nothing deletes one on your behalf either -
until it can no longer be reached at all. **A stored document lives while a
collection binds it, or while a run you still have names it**; once neither is
true, the engine reclaims it during its ordinary housekeeping (on startup, after
a run, after a sync, after a collection is deleted). That is what keeps a year of
weekly syncs of a 12 MB document from leaving a year of 12 MB rows behind: a run
pins the document it was measured against for exactly as long as the run itself
is retained, so its [coverage](#contract-coverage) always has a source, and the
superseded copies go.

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
- The binding records the document's **hash and the moment it was bound**, which
  the engine stamps as it stores the two rows. Contract coverage and response
  validation both compare that hash against the stored document before they
  measure anything, so a binding without it is a collection nothing is measured
  against - which is what imported collections were, until issue #709. Bindings
  made before that fix are stamped on the next engine start.
- Every request created from an operation records that operation's
  `operationId` (when the document declares one), its method, and its
  **templated** path - `/pets/{petId}`, not the URL the request sends.

Other formats are unaffected. A Postman or Insomnia import binds nothing and
records no operation identity: those files describe requests, not a contract.

### Importing a document you are already bound to

Importing a spec that a collection already binds used to make a second
collection from scratch, and say nothing about the first. The two then diverged
with nothing marking which was real: the bound one keeps its operation
identities, its saved examples and its coverage history, and the fresh one has
none of that while looking newer.

So the import **stops and offers the choice**. Before anything is written, Vayu
looks for a bound collection whose document matches the one being imported:

| Matched by | The case it catches |
|---|---|
| The URL it was fetched from | The same address, serving a document that has changed since - what [Sync](#checking-a-bound-spec-for-changes) is for. The bytes cannot match here; they are what changed |
| The stored bytes | A document with no URL to match on - a file picked twice, or the same text pasted again |

The dialog names the collection and offers **Sync instead**, which opens that
collection's Spec tab, and **Import anyway**, which imports exactly as before -
a second copy of a spec is a real thing to want, so this is a fork and never a
block. A document nothing is bound to imports straight through, with no dialog.

A URL is compared as written: a trailing slash or a different query is a
different address. A document imported through several files is compared as the
bundle, which is what was stored.

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
says so rather than storing a truncated contract. **So does a single document
over the same limit**, before it is parsed and before the preview is built
(issue #719) - the check used to run only while following references, so a
generated single-file spec too large to store was fetched, parsed and previewed
in full, and refused by the engine only once you pressed Import, which failed
the whole transaction. The message names the size, the limit and the setting.
The limit is the *spec document* one: a Postman or Insomnia export is stored as
collections and requests, so it is not measured against it.

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
matches are stamped. **Nothing is created or deleted**: acting on the difference
is what applying a sync will do.

### Identity from another document is cleared

One thing a bind does rewrite, and it says so before it does: a request that
records an operation the document being bound does not account for has that
identity **cleared**. The rule after any bind is one sentence - *a request's
operation is the one it matched in the bound document, or nothing.*

This is the re-bind case, and only that case. Unbinding leaves every recorded
operation exactly as it is, so unbind and bind the same document again and
nothing is lost. Bind a *different* one, though, and without this the requests
that do not match it would keep identity from the old document - which is worse
than no identity, because [coverage](#contract-coverage) resolves a stamp by its
`operationId` first, so a stale stamp claims whichever operation of the new
document happens to share that id.

The summary counts them before you press Bind. The bind itself is one engine
transaction - the document, the binding and both halves of the stamping land
together, or none of them do - so there is no half-bound state to report
afterwards: a bind that failed changed nothing, and the collection is still
bound to whatever it was bound to.

## Checking a bound spec for changes

A contract moves. The **Sync** section of the Spec tab re-reads the bound
document, tells you what moved, and applies the parts you tick. **Checking
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
  fields an import writes (name, description, method, URL, params, headers,
  body) is no longer what the document produces.

Everything else is counted as unchanged, and requests carrying no operation at
all are counted separately: the contract never described them, so the comparison
leaves them out and says how many it left out.

### The fourth kind: a change no request row can carry

The three buckets describe operations, and plenty of contract changes are not
about an operation's request shape at all - a tightened response schema, a newly
documented `429`, an edited `servers` block. Those move the document without
moving a single request, so all three buckets come back empty and the summary
reads `0 new · 0 gone · 0 changed · N unchanged`.

That is a real change, and it is applyable. The section names it
**document-level changes only** and offers **Update the stored document**, which
stores the new document, moves the binding to it, and rebuilds the
response-schema and coverage indexes - without touching one request row. It is
the same single transaction as any other apply, with an empty set of rows.

This is also what you get when a diff *does* offer rows and you untick them all:
the apply is always available while the bytes differ, and it always says which of
the two it is about to be. Response validation and coverage read the document
they were stored against, so a collection that can never take the new document is
a collection judging every run against a contract that has moved on.

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
- An **`operationId` that means two things is not followed at all**. Generated
  documents sometimes declare one id on two operations, which is invalid
  OpenAPI; those requests are followed by their method and path, and a request
  whose endpoint the document no longer declares is reported as gone rather than
  attached to the other operation that shares its id. An import keeps a repeated
  id on the first operation only and says so in the preview, so a freshly
  imported collection carries no ambiguous identity at all - one imported before
  that rule has its identity repaired the first time a sync is applied.
- A **path that still exists wins over an id that points elsewhere**: if the
  document declares the request's own method and path, that is the operation it
  is, whatever some other operation's `operationId` claims.

### What you edited is marked as yours

A changed field is marked **edited here** when what the request holds is neither
what the new document produces *nor* what the bound one did. That is the only
evidence that a person put it there, and it is what stops applying a sync from
quietly reverting your work. When the bound document itself cannot be read, the
section says so for that request instead of guessing which side a difference came
from.

**Saved response examples are not compared.** Comparing them costs a query per
request, and what happens to them is a rule rather than a difference to weigh -
see [What applying does to examples](#what-applying-does-to-examples).

## Applying what the check found

Every item is a checkbox, and applying is deliberately partial: take the four
new operations and keep the one request whose operation was removed, if that is
what you want. What arrives ticked is what applying can only restore, never
destroy:

| Item | Ticked by default? |
|---|---|
| A new operation | Yes - it creates a request that was not there |
| A changed field the document moved | Yes |
| A changed field marked **edited here** | **No** - your value is only overwritten if you tick it |
| Every field of a request whose bound document could not be read | **No** - see below |
| A request whose operation the document no longer declares | **No** - it would be deleted |

When the bound document cannot be read at all, nothing about that request is
ticked for you: "you edited this" is a three-way judgement, and with one side
missing it is not a judgement anything can make.

**Applying is one call and one engine transaction.** The re-fetched document is
stored, the collection's binding moves to it, and every created, updated and
deleted request lands with it - or none of it does and the collection stays
bound to the document it was bound to before. There is no half-applied sync to
find and repair.

**Every apply stores the document; the ticks decide which requests ride along.**
That is why an apply is offered whenever the bytes differ, and why the button
names which of the two it is - *Apply selected*, or *Update the stored document*
when no request row is ticked.

**Your method edit is a tickable field like any other.** The HTTP method is one
of the fields an import writes, so a document that moves an operation's verb
offers it as a row you can take, and a verb *you* changed is marked **edited
here** and left for you to decide. Leaving it unticked means the request keeps
sending what you set while its recorded identity says what the document declares
- a difference the next check shows you again rather than silently resolving.

Deleting is behind a confirmation that names the count, and the deletions ride
in the same apply as everything else you ticked.

### Where a new operation lands

In the sub-collection named after its first tag - or, when the operation
declares no tag, the one named after the first meaningful segment of its path -
exactly where an import would have filed it. The folder is matched by name
against those the bound collection already has, and created once when there is
none. An operation that gets neither name (a path like `/` or `/{id}`) lands on
the bound collection itself.

### What applying does to examples

Applying a change to a request also **refreshes that request's response examples
from the document**: the examples a previous import or sync wrote are replaced
by what the document now documents.

- Examples you saved from a live response are **never** replaced. The engine
  records who wrote each one (`origin`), and only the imported ones are in
  scope. The Examples panel marks the imported rows with an **Imported** chip,
  so which rows a sync owns is visible where they are managed.
- **An imported example you deleted stays deleted.** A sync refreshes examples
  whenever it applies *any* change to a request - a rename is enough - so
  before this the next sync silently brought a deleted one back. The engine now
  records the deletion and the refresh skips that response status; re-importing
  the document is the one thing that brings it back, and the delete dialog says
  so. What is remembered is the **status**, not the example's name, because a
  name carries the document's response description and changes when the
  document rewords it.
- The order is preserved where it can be: your saved examples never move, and a
  refreshed example never jumps ahead of one that was already in front of it.
  This matters because a mock server answers with the *first* example.

### What a sync will never touch

Nothing outside the collection being synced. The engine checks that every
request an apply updates or deletes lives beneath that collection, so a sync is
an operation on one contract's collection and cannot reach anything else -
including a second collection bound to the same document.

Auth and scripts are not spec-derived and are never written by a sync: an import
sets auth to `inherit` and the scripts to empty for every operation, so anything
there is yours.

## Export - back out to a document

Any collection exports as an OpenAPI document, from its ⋯ menu in the sidebar or
from the **Export as OpenAPI** button on the Spec tab. The document is assembled
by the engine, from what is stored, and written to a file you choose the format
of - JSON or YAML, the same document either way. Nothing is sent anywhere, and
nothing is written: an export is a read of what the collection already is.

Because it is the engine's, an agent can ask for the same document over MCP
(`export_spec`) rather than only through this dialog.

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
  Vayu flows back into the contract. An example Vayu only kept **part** of - the
  Examples panel marks those, and a big response is capped as it is saved - is
  the one kind that does not: the status is documented, the body is not, and the
  dialog counts it. Half a payload written as the payload would be
  indistinguishable from a complete one to everyone downstream, including the
  mock server.
- **Everything else survives.** Vendor extensions, `info`, `tags`, `security`,
  components nothing references - all of it is carried through, because export
  patches the document rather than rebuilding it. The dialect is left alone too:
  a 3.0 document exports as 3.0, never quietly upgraded.

**The export reaches every request under the collection - down to the next
document.** A sub-collection bound to a *different* spec answers to that spec,
so its requests are left to its own export: they carry operation names of the
other document (`listUsers`, `GET /users` - names generators hand out in every
document), and letting them through would have them claim operations here and
overwrite them with values from somewhere else. A sub-collection bound to the
**same** document is part of this export, because its requests describe these
very operations - stopping there would remove them as operations nothing claims.

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
recorded, an example stored only in part (the response is written, the body is
not, in both of those last two). Nothing is dropped quietly.

A large document takes a moment to put together, and the dialog says
**Assembling the document…** while it does. Switching between JSON and YAML asks
for the other format once; switching back is immediate, because the first one is
still there. Reopening the dialog asks again, so an export always describes the
collection as it is now.

## Contract coverage

A run of a bound collection reports **which operations it exercised and which of
their declared responses it saw**. It answers the question a green run still
hides: every assertion can pass while four of eighteen operations were never
called at all.

It appears in three places, and only for a run that was measured against a
contract:

- The run's **Overview**, beside the pass/fail budgets.
- A collection run's own view, above the step list.
- One line on the **Spec tab**, for the collection's last run.

### What a coverage block says

| Number | What it counts |
|---|---|
| Operations covered | Operations the run sent at least one request for |
| Declared responses seen | Status patterns the document declares that the run actually produced |
| Undeclared statuses | Statuses the run saw that the document declares nothing for |
| Never called | Operations with no request at all - listed first, because they are the finding |

A status answers to the **most specific** pattern that covers it. An operation
declaring both `200` and `2XX` that only ever answered 200 reports `2XX` as not
seen: those are two distinct promises, and the run produced one of them. A
`default` catches whatever the exact and range patterns did not.

A **transport error** - a request that never got a response - counts as a request
sent and as no response seen. The operation still counts as covered (something
was tried), no declared response is hit, and the row says how many failed. Status
`0` never appears as a status the server sent, because no server sent it.

Requests whose operation the document does not declare are counted too, as
`requests went to operations this document does not declare`. That is a
collection that has drifted off its contract, which is exactly what the block
exists to notice.

### Reading a row

Each row lists the statuses that operation answered with. A status the document
declares **no** response for carries a warning tint behind it and reads as
`undeclared` to a screen reader - so the header's "N undeclared statuses
observed" is answerable from the rows below it, not just a total. The status
keeps its own colour either way: an undeclared 503 is still a server error.

Two further findings appear on a row only when they happened, because they are
zero on almost every one:

| On the row | What it means |
|---|---|
| `+N more` | The per-operation status list is capped, and N distinct statuses this operation answered with are not among the ones shown |
| `N off-range` | Responses whose status fell outside 100-599, which no status class describes |
| `N failed` | Sends that never got a response at all |

### What is exact and what is sampled

**Every number in a coverage block is exact.** It is counted as each request is
sent and each response comes back, not derived from what the run stored. This
matters because the block sits among figures that *are* sampled: under load, the
latency percentiles come from every completion but the stored `results[]` rows
and their bodies are a bounded reservoir. Coverage computed from those rows would
report an operation as uncovered whenever the store happened to thin the only
request that touched it.

The two contract blocks a run report carries are therefore **not the same kind of
number**, and they sit next to each other:

| Block | Counted over | Why |
|---|---|---|
| Contract coverage | Every request sent and every response received | One atomic increment per completion is cheap enough for the hot path |
| [Schema validation](#schema-validation-under-load), under load | The bounded reservoir of responses the run stored | Validating a body is not, so it is deferred to run end over what was kept |
| [Schema validation](#schema-validation-in-a-collection-run), in a collection run | Every step the run executed | A collection run sends one request at a time, so there is no hot path to keep off |

The last row is why the block states its own denominator instead of leaving a
reader to infer it from the run's mode: the same numbers mean two different
things, and only the block knows which.

### Which document a run is measured against

The document the run was **planned** with, pinned by the `specId` and `specHash`
stamped on the run - not whatever the collection is bound to now. Sync the
binding to a newer spec and an older run's report still says what that run
actually covered.

**Which collection's binding that is** follows the same rule a single Send does:
the nearest bound collection walking from the one that ran up to the root. An
import binds the root and files every request under its tag sub-collections, so
running the `pets` folder is measured against the whole document - it is not an
unbound run, and it was never meant to be one.

That makes a scoped run's coverage **partial on purpose**: the run enumerates one
folder, the contract is the whole API, and the operations under every other tag
are honestly uncovered. The block says so in a line of its own when the contract
came from a parent collection, so `4 / 618 operations` reads as the scope of the
run rather than an API nobody is calling.

### When there is no coverage block

Absent, never zeros, in each of these cases:

- The collection is not bound to a document, and neither is any collection
  above it.
- The run was a single request rather than a collection run.
- The bound document has **no operation index** - it was stored before this
  existed, or it declares no operation at all (a stored file that is not a
  contract). Re-bind or sync the collection and its next run reports coverage.

A run that was never judged against a contract did not cover none of it, and the
report spells the two differently.

### For a CI gate

The rollup carries plain numbers - `operationsCovered`, `operationsTotal`,
`declaredResponseCoveragePct` - shaped so a future headless gate can threshold on
them the way it would on the run's pass/fail budgets. Nothing thresholds on them
today; the shape is the commitment.

## Does this response match its schema?

A request in a bound collection is checked against the schema its document
declares for it, and the answer sits in the response's status bar as a chip -
**Matched schema**, **Schema failed**, or **Schema not checked** - with the
detail in the **Tests** tab, beside whatever a Tests script asserted. A schema
check is a test result the spec wrote rather than one you did, which is why it
lands there rather than in a tab of its own.

A collection bound to no document shows **nothing at all**. That is the
difference the whole feature turns on: a response nobody judged against a
contract did not pass one and did not fail one.

### Which schema answers

The one the document declares for this response's status and content type:

- The **status** matches the most specific pattern that covers it - `200` before
  `2XX` before `default` - the same rule [contract
  coverage](#contract-coverage) counts by.
- The **content type** matches exactly first, then a declared `*/*` or
  `application/*`.

### When a response is not checked

Not a failure, and it says which of these it was:

| It says | Because |
|---|---|
| This request is not bound to an operation | The request carries no operation identity - match or re-bind the collection |
| The bound document carries no response schemas | It was stored before this existed, or declares none. Sync or re-bind |
| The stored document has changed | The binding names a version this document no longer is. Sync |
| The binding never recorded a version | The collection is bound to a document and to no version of it, so there is nothing to compare - re-bind. Vayu stamps the version on every write and repairs older bindings at startup, so this means the database was edited from outside |
| The spec no longer declares this operation | The contract moved and this request did not |
| The spec declares no response for this status | A 500 nothing documented, for instance |
| No schema for this content type | The status is declared; this media type is not |
| The body is not JSON | A JSON Schema cannot describe HTML |
| There was no response | The request never reached a server |

A response the document writes as a reference -
`"404": {"$ref": "#/components/responses/not_found"}`, the shape GitHub's public
spec uses for nearly every response - is read through to the component it names,
so it is checked like any other.

**A collection bound before that was true keeps the index it was stored with**,
and reports *the spec declares no response for this status* against every
`$ref`-ed response in it. The index is rebuilt when the document is stored
again, so the remedy is to **re-bind** the collection from the
[Spec tab](#binding-a-collection-you-already-have) - or to sync it, if the
document upstream has genuinely changed. A **Check for changes** against a
document whose bytes are identical reports *unchanged* and stops there, by
design: it compares bytes, and these bytes did not move.

### Where OpenAPI stops being JSON Schema

Schemas are translated by the engine when the document is stored, because a
validator reads JSON Schema and OpenAPI 3.0's dialect is *not* it. `nullable: true` becomes a
union with null, 3.0's draft-04 boolean `exclusiveMinimum` becomes the bound
itself, and `discriminator` / `xml` / `example` are dropped as things that
describe no constraint. Without that step a null the document explicitly permits
would be reported as a type failure - a wrong answer, which is worse than no
answer.

**OpenAPI 3.1 is JSON Schema 2020-12, and the validator reads draft-07.** Its
newer keywords - `unevaluatedProperties`, `prefixItems`, `dependentSchemas` -
are not translated and cannot be evaluated, so they are **named and counted** on
the verdict instead: the chip reads *Schema partly checked* and the Tests tab
lists which keywords went unread. A body can pass every check that ran while the
part of its schema that would have rejected it was never looked at, and saying so
is the only honest way to show a green verdict beside a schema that was half
read.

## Schema validation under load

A **load run** of a bound collection reports whether the responses it kept
matched the schemas the document declares, in a block on the run's **Overview**
beside [contract coverage](#contract-coverage).

It is checked **at the end of the run, over the responses the run stored** -
never as each response arrives. A load run refills concurrency on every
completion, so a schema walk on that path would cost the run throughput for as
long as it lasted, and it would do so as a slightly lower RPS nobody would trace
back to validation. Deferring it is what keeps the numbers the run reports about
itself honest.

### These numbers are sampled, and the block says so

| Number | What it counts |
|---|---|
| Sampled | Responses the run kept and this pass walked - the denominator for everything else |
| Checked | Of those, the ones a declared schema could speak about |
| Matched | Checked responses that satisfied their schema |
| Did not match | Checked responses that did not - the finding |
| Not checked | Accounted for by reason, one line each, in the same words a single response shows |

So **"0 did not match" means no *sampled* response failed**, not that no response
failed. A run whose reservoir held 40 of 30,000 responses checked 40 of them.
That is the difference from the coverage block sitting directly above it, whose
every number is exact - and it is why the two carry a sentence each saying which
kind they are.

A response whose body is not JSON, or whose status the document declares nothing
for, is **not checked** rather than failed. It did not break its contract; no
schema spoke about it.

### Which responses a run keeps

A load run stores a bounded reservoir per step, drawn uniformly across the whole
run. A step is kept when something will read it: it carries a **Tests** script,
or it is bound to an operation and the document carries schemas. The run's whole
sample budget is split evenly across those steps, so a bound collection that also
asserts gives each step fewer samples than it would have had for scripts alone.
What was displaced is reported as the run's dropped-sample count, next to the
figures it explains.

### When there is no schema-validation block

Absent, never zeros, in each of these cases:

- The collection is not bound to a document, and neither is any collection
  above it.
- The run was a single request rather than a collection run.
- The bound document carries **no response schemas** - it was stored before this
  existed, or declares none. Re-bind or sync the collection.
- Nothing survived sampling.

A run whose responses were never checked did not pass a contract, and the report
spells the two differently.

Keywords the validator could not evaluate are disclosed here exactly as they are
for a single response: **named and counted**, because a matched count computed
against a schema half of which went unread is narrower than it looks.

## Schema validation in a collection run

Every step of a collection run is judged the same way, and the verdict rides
three surfaces:

- The **step row** carries the same three-state chip the response pane does, and
  expanding it shows the failure list and the dialect disclosure in full.
- The run's **Overview**, and the collection run's own view above the step list,
  carry the same `Schema validation` block a load run writes.
- The **live step stream** carries it too, so a run being watched shows verdicts
  as they happen rather than only once the report is written.

A step that sent nothing - skipped by a script, or stopped by a `{{data.column}}`
with no column - carries **no verdict at all**. There was no response to judge,
and an unchecked verdict there would be reporting on a request nobody made.

The run is judged against the document it was **planned** with, read once when
the plan resolved. A sync landing mid-run stores a new document and moves the
binding; it does not change what the run in flight is measured against.

### These numbers are exact, unlike a load run's

A collection run checks **every step it executed**, so its block is counted on
the same evidence coverage beside it is. That is the one way it differs from the
load-run block above, and the block says which it is rather than leaving a reader
to infer it from the run's mode - "0 did not match" is a wider claim here than
there, and only the sentence under the numbers can tell them apart.

### A schema failure does not fail a step, unless you ask

By default a schema verdict is its **own channel**: a step whose response does
not match what the document declares still passes if its assertions passed, and
the row shows both facts. They are different claims - one is about your
assertions, the other about the contract - and folding the second into the first
would make every undocumented field look like a broken test.

Turn on **Fail steps on schema errors** in the Run Collection dialog to make the
contract a gate. Then a step that passed everything else and whose response did
not match is **failed**, with the first problem named in its error. A step that
was already failing keeps the error that named it: that is the one to fix first.

The switch is design-mode only, because only the design-mode runner can honour
it: a scenario *load* run validates its sampled responses once the run has
drained, long after the step outcomes were decided, so the option is not offered
there. Over the wire it is `failOnSchemaError` on `POST /runs`, sent only when
it is on - and the report records it beside the tally, so the **Schema
validation** block on a run started this way says the contract was a gate. A
failure count means a different thing with the gate than without, and that line
is where a reader coming back to an old run finds out which they are looking at.

From MCP, `run_collection` takes the same switch on the same terms (issue #766):
`failOnSchemaError: true` runs the collection in design mode with the contract
as a gate, and the key is sent only when asked for, so a run started without it
is stored exactly as one started before the flag existed. `start_load_run`
refuses it for the reason the dialog hides the switch in load mode.
`run_collection_smoke` is the same choice with the opposite default: it has
folded a failed schema verdict into each row's pass/fail since it grew verdicts
at all, so pass `failOnSchemaError: false` to keep the verdict on the row
without letting it decide. Either way the row carries what the document said.

| | Step outcome | Schema verdict |
|---|---|---|
| Assertions passed, body matched | passed | matched |
| Assertions passed, body did not | passed (`failed` with `failOnSchemaError`) | failed |
| An assertion failed, body did not match | failed - names the assertion | failed |
| Bound collection, no schema for the status | unchanged | not checked |
| Unbound collection | unchanged | *no verdict* |
