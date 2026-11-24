---
description: >-
  The GraphQL helper library in the Vayu desktop app (lib/graphql/): envelope, diagnostics, schema cache, explorer and Monaco language providers.
---

# GraphQL Library (`lib/graphql/`)

Shared, Monaco-independent modules that power the GraphQL body mode.

| File | Role |
|---|---|
| `graphql-body.ts` | The GraphQL-over-HTTP envelope, converted to and from the two editor panes. [Details](#graphql-bodyts) |
| `diagnostics.ts` | Pure (Monaco-free) diagnostic computation: a syntax check without a schema, full validation with one. [Details](#diagnosticsts) |
| `templates.ts` | The three maskings `{{variable}}` tokens need, split by whether the caller needs the *positions* back or the *token text* back. [Details](#templatests) |
| `format.ts` | Format Document for GraphQL, via prettier's graphql parser loaded on demand. [Details](#formatts) |
| `introspect.ts` | Fetches a `GraphQLSchema` by routing the standard introspection query through the engine, avoiding CORS. [Details](#introspectts) |
| `schema-cache.ts` | Zustand store (`useSchemaCache`) keyed by `schemaCacheKey(target)`: the endpoint URL plus the credentials it is reached with. [Details](#schema-cachets) |
| `schema-status.ts` | The one sentence about the schema in hand, derived from a `SchemaEntry` alone - the per-kind failure hint (#383) plus freshness. [Details](#schema-statusts) |
| `language-providers.ts` | Registers Monaco language providers for `graphql`: completion, hover, debounced diagnostics and formatting. [Details](#language-providersts) |
| `schema-tree.ts` | The explorer's tree model and its search index. [Details](#schema-treets) |
| `insert-skeleton.ts` | Turns an explorer row into an edit of the query document, under one contract: **the document still parses afterwards, and can be run**. [Details](#insert-skeletonts) |
| `explorer-store.ts` | Zustand store for the explorer's view: whether the pane is open, and per schema the search text, expanded rows and scroll position. [Details](#explorer-storets) |
| `reveal-store.ts` | One slot: the operation the context bar's outline asked the query editor to scroll to. [Details](#reveal-storets) |
| `variables-schema.ts` | Derives a JSON Schema from the query's `$variable` definitions and applies it to the variables editor. [Details](#variables-schemats) |
| `variables-diagnostics.ts` | What a JSON editor's markers are computed from when its text may hold `{{token}}`s outside strings. [Details](#variables-diagnosticsts) |

`lib/monaco-setup.ts` (sibling of `lib/graphql/`) configures `@monaco-editor/react` to use the locally bundled `monaco-editor` instead of the jsDelivr CDN, wires language web workers via Vite `?worker` imports, and calls `registerGraphqlProviders`. It is a side-effecting module, and `lib/monaco-loader.ts` is its only importer: `ensureMonaco()` pulls it in when the first `CodeEditor` mounts rather than at startup, and `CodeEditor` renders a placeholder until it resolves (#1146). That order is the requirement, not an optimisation - `loader.init()` running before `loader.config({ monaco })` sends the app to the CDN for a copy it already ships. Anything that needs the instance without wanting to load it (the `pm.*`, `{{variable}}` completion, `{{variable}}` hover, and script-type providers registered from `App`) subscribes with `useLoadedMonaco()`. That same composition also defines the app's Monaco theme (`vayu-light` / `vayu-dark`, #1321), because it has to precede the first `editor.create` - a theme name Monaco does not yet know falls back to `vs` and never revisits it, so registering later, from a React effect, would be too late for the editor that mounts first.

## `graphql-body.ts`

The GraphQL-over-HTTP envelope, converted to and from the two editor panes.
Keeps `operationName` and any key it does not model (`extensions`) across a round trip - the pair used to carry `{query, variables}` alone, so one keystroke deleted the rest.
Variables that hold `{{tokens}}` outside a string are written into the envelope verbatim (the engine resolves them before sending); variables that are broken for any other reason are still dropped, and `classifyVariables` is what the pane's badge reads to tell the two apart.
A string-typed `variables` (Postman's shape) shows verbatim rather than JSON-encoded.
Also `operationNames` (which operations a document defines, for the picker), `documentOutline` (kind, name **and** starting line of every operation, anonymous ones included, for the context bar's outline - `operationNames` drops all three, since it answers the narrower "what may be sent as `operationName`") and `findOperationLine` (where an outline row's operation sits in *another copy* of the document - the bar reads the stored request and the editor holds the live buffer, so a row is resolved by name rather than by carrying its line across).

## `diagnostics.ts`

Pure (Monaco-free) diagnostic computation - syntax check via `graphql.parse` when no schema is available; full field/type validation via `graphql-language-service.getDiagnostics` when a schema is loaded.
Returns 1-based `GqlMarker[]` matching Monaco's `IMarkerData` shape.
`{{variable}}` tokens are masked before the pass and any marker landing on one is dropped, so the editor no longer flags an idiom the engine supports - and, because an unmasked token is a *parse* failure, the rest of the document stays validated.

## `templates.ts`

The three maskings `{{variable}}` tokens need, split by whether the caller needs the *positions* back or the *token text* back.
For GraphQL text, a length-preserving swap to a Name plus the spans, so marker positions stay usable against the original.
For JSON text on the wire path, a string-aware swap to a sentinel string (tokens already inside a JSON string are left alone), so a templated variables object parses and can be written back verbatim.
For JSON text being diagnosed, the same string-aware scan swapping each token for a JSON string of its exact length, plus the spans - never unmasked, which is why it can use a placeholder a user could also have typed.

## `format.ts`

Format Document for GraphQL, via prettier's graphql parser loaded on demand.
It was `print(parse(text))`, which has nowhere to hang a `#` comment and deleted every one of them; returns null on unparseable input so the caller pushes no edit.

## `introspect.ts`

Fetches a `GraphQLSchema` by routing the standard introspection query through the engine, avoiding CORS.
Composes first (`apiService.composeRequest`, `POST /compose`) so the endpoint's `{{variables}}` and its **Auth panel** config - `inherit` walked through the collection chain, OAuth 2.0 included - are resolved engine-side, then overlays the introspection query onto the composed payload and sends it with `apiService.executeRequest`.
It holds no resolution logic of its own; the composed body and script parts are dropped, since introspection is not sending the user's request.
The execute payload carries `transient: true` and the target's `environmentId` (issue #382), so the fetch leaves no run row, trace or History entry behind and still reads the environment's cookie jar.

## `schema-cache.ts`

Zustand store (`useSchemaCache`) keyed by `schemaCacheKey(target)` - resolved endpoint URL **plus** the credentials it is reached with (collection scope, environment, auth block), because introspection now sends auth and two environments can point one URL at different credentials.
Headers are deliberately out of the key (they are edited keystroke by keystroke); a hand-typed `Authorization` needs the Refresh button.
Callers hand over a `SchemaTarget` and never build the key.
States: `idle → loading → ready \| error`.
`ensureSchema` skips targets already attempted; `refreshSchema` forces a re-fetch.
Exposes `getActiveSchema()` and `getActiveStatus()` for Monaco providers.
It keeps the active *key*, not the target it hashed from: the target sat beside it only so the context bar's Refresh could call `refreshSchema` without rebuilding the resolved URL and auth, and that Refresh is gone (#1224), so the field went with it rather than staying as state nobody reads - a caller needing a target again holds the one it already has, the way `GraphQLBody` does.

## `schema-status.ts`

The one sentence about the schema in hand, derived from a `SchemaEntry` alone - the per-kind failure hint (#383) plus freshness.
Pure and Monaco-free, beside the store it reads.
Two surfaces rendered it - the explorer header's badge and the Query pane's chip - and a second copy in either is how the two came to describe one subject in different words from different panes (#455); the badge now has one home, in the Query header's schema control (#1224).

## `language-providers.ts`

Registers Monaco language providers for the `graphql` language: completion (fields, types, directives, each carrying the kind the language service classified it as), hover type info, debounced inline diagnostics (re-runs on content change and on schema cache updates), and document formatting (`format.ts`).
Completion triggers on structural characters only - never space or newline, which popped the widget so the next Enter accepted a suggestion instead of breaking the line.
Call once after `loader.config`.

## `schema-tree.ts`

The explorer's tree model and its search index.
Children are computed **on demand** per expanded row rather than built into a tree up front - a schema is a graph (`User.posts` → `Post.author` → `User`), so materialising it either recurses forever or prunes branches on the user's behalf.
A field row carries the `rootPath` it was reached by (`[Query.user, User.posts, Post.title]`), which is the one thing insertion cannot recover on its own; rows browsed under the Types branch have no path and say so with a null.
The search index *is* materialised - one pass over the type map, no traversal - because a search has to see rows nobody expanded, and it covers **every kind `childNodes` can produce**, enum values and input-object fields included: a row browsable one click later must not answer "Nothing matches".
Both of those carry a null `rootPath` like a Types-branch row, so insertion refuses them by kind rather than guessing a route.
A field row also carries `returnType` - what the row draws, since an unbounded argument list dragged the result type off a 34% pane - and `args` in declaration order; a field that takes any expands into an **Arguments** container ahead of the fields of what it returns, the same shape **Returned by** already uses, and each argument row carries an `argumentOwner` naming the field and route it belongs to rather than its own, since its `name` is the argument's.
An argument whose type is an input object or enum expands again into that type's members.
`signature` is untouched and still the whole `(args): type` string - it is the search index's middle tier, so searching an argument name still finds the field - and the **Arguments** container and its rows are deliberately absent from that index, since an argument has no tree address of its own for `treeLocationOf` to reconstruct.
Each entry keeps its name, signature and description lowercased separately rather than as one haystack, because the ranking turns on *which* of them matched; a match reports its offset in the name **and** in the description together with the **tier** it landed in, and `splitAtMatch` cuts either into the three segments the row draws - the tier because "where do I mark it" and "why is this row here" are different questions, and only the second decides how much of a description the pane owes the reader.
`groupSearchMatches` partitions the ranked list by branch without reordering inside a group, and `treeLocationOf` walks a search row back to where it lives in the tree, reconstructing the address from the same id builders `childNodes` uses so the two cannot drift.
**Within the name tier the closest match wins** - earliest offset, then shortest name, so an exact match needs no special case - and the whole index is scanned before the `limit` (200) cuts, because a better match than the first 200 is routinely declared after them: in declaration order, a schema of 60 `POST_*` enums ahead of its `Post` type returned 200 leaf rows and neither the type nor `Query.post`.
The index arithmetic stays here, out of the component, so it is testable without a DOM.
One route *into* the graph is materialised beside it: `rootFieldsReturning` reads, once per schema and cached against it, which root fields answer with a given type - the answer to the question a type row could not otherwise answer, and what a `Post` row shows as its **"Returned by"** container and inserts through.
It stops at the root operation types on purpose (a one-hop answer is one the user can check at a glance, and a search through the whole graph would be back to guessing a route nobody chose), skips Subscription (browsable here, not runnable), and keys only object, interface and union types, since "what returns a String" is noise and "insert a String" is not a query.
**One hop includes the members of what a field declares**: `Query.node: Node` is keyed under every type implementing `Node`, carrying a `narrowTo` the route's step passes on, because keying only the declared type left a Relay-shaped schema - one `node` field, every concrete type behind it - with no route to anything at all.
A route that returns the type outright outranks one that narrows to it, so a schema of direct returns is unchanged.

## `insert-skeleton.ts`

Turns an explorer row into an edit of the query document, under one contract: **the document still parses afterwards, and can be run**.
Parsing is not enough on its own - a lone `fragment PostFields on Post { … }` is valid GraphQL holding no operation, which is what a type row used to write onto an empty document and what Send gets nothing back from.
So a **type row inserts the query that returns the type** (`rootPathsToType`, best route first, a deprecated root field never chosen).
A step that narrows writes the inline fragment it needs (`node(id: $id) { ... on Post { … } }`) - not the "probably compatible" guessing this module refuses, but the narrowing without which the selection would not be legal.
Where no root field returns the type at all, `insertFragment` writes the definition **and the spread that uses it** - one edit, because `Fragment "X" is never used` is a validation rule and a lone appended definition rejects the whole request, the operation the user already had included.
The spread's host is decided by `doTypesOverlap`, the predicate `PossibleFragmentSpreadsRule` validates with, so a fragment on a concrete type lands inside the interface or union selection it belongs in (the innermost set that can hold the spread wins, whether it matches the fragment's type exactly or merely overlaps it - a spread made from inside `... on Post` stays inside it rather than climbing out to the `Node` set that matches exactly); with no host anywhere on the cursor's chain it refuses, since parsing was never the bar.
A **field found by search under a non-root type borrows the same route** rather than refusing whenever the cursor is not already inside its owner - the commonest search result there is, and the commonest refusal.
A field lands in the cursor's selection set only when that set's type owns it (no inline-fragment guessing on an interface or union), then in an enclosing set, then as a new named operation; a cursor *inside* an inline fragment is read at the type that fragment names, which is the other half of the same rule - the set the app itself wrote when the route narrowed, so skipping it made a click in there insert a second copy of the whole route instead of a sibling line; a path-less row with nowhere to go is *refused out loud* rather than guessed at.
Required arguments become `$variables` **and are declared on the operation that gains them** - including promoting a shorthand `{ … }` operation to `query ( … )`, which otherwise cannot carry any.
`insertArgument` writes one more argument the same way, onto a field the document may not select yet: it is not a selection but is written *onto* one, so a field that is not there yet is inserted first by the ordinary rules above and the argument lands on what that wrote; an argument the selection already carries is reported rather than written twice, and one on a field behind a subscription is refused, naming the subscription rather than the argument.
Also `mergeVariables`, which folds new variables into the Variables pane only when its text is strict JSON: merge, never replace, and never touch a `{{token}}` draft - what it could not write comes back as `pending` for the badge to name.

## `explorer-store.ts`

Zustand store for the explorer's view: whether the pane is open, and per schema identity (the same `schemaCacheKey`) the search text, the expanded row ids, the scroll position and whether rows show their full description.
`revealPath` opens a whole ancestor path in one write and clears the search: a union rather than a toggle, so a path already half-open does not get half-closed on the way down, and one write rather than one per level, so the tree renders once.
A store rather than component state because Radix unmounts the whole Body tab on a glance at Headers - the body drafts learned this the hard way.
In memory only, capped at `EXPLORER_VIEW_MAX_ENTRIES` (8, matching the schema cache): an expansion set describes a schema that may not exist next launch.

## `reveal-store.ts`

One slot: the operation the context bar's outline asked the query editor to scroll to.
The outline sits outside `RequestBuilderProvider` and the Monaco instance stays private to `GraphQLBody`, so what crosses the boundary is a request to reveal rather than the editor itself.
Consume-and-clear, the same shape as the insertion effect and for the same reason - a command left in the slot is replayed on the next remount, which the Body tab does on every glance at Headers.
Cleared by whoever decides its fate: `GraphQLBody` after revealing (or after failing to find the operation), the provider for a command naming another request or one whose body is no longer GraphQL.

## `variables-schema.ts`

Derives a JSON Schema from the query's `$variable` definitions + the introspected schema via `getVariablesJSONSchema`, then applies it to the variables editor through `monaco.json.jsonDefaults` so variable values are validated and autocompleted.
The query is masked before it is parsed - one `{{token}}` anywhere used to cost the pane the schema for every variable the query declares - and the schema is registered against the pane's masked twin as well as the pane itself.

## `variables-diagnostics.ts`

What a JSON editor's markers are computed from when its text may hold `{{token}}`s outside strings - the Variables pane and the request body's `json` / `jsonrpc` modes (#3137): a hidden twin model holding the editor's text with every out-of-string token masked to a same-length JSON string.
Monaco's JSON worker validates the twin, and its markers are republished on the visible model minus the ones that land on a token - so a `{{token}}` no longer reads as a syntax error while a genuine mistake beside it, which the aborted parse used to swallow, now does.
Filtering the worker's markers on the model itself cannot do this: one token also earns an `End of file expected.` on the character *after* it.
