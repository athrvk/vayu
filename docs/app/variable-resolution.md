# Variable Resolution

Vayu resolves `{{variableName}}` placeholders at request-execution time using a layered
priority system. Higher-priority layers override lower ones; within each layer the last
write wins.

**Where resolution runs (since issue #226):** the **engine** owns
execution-time resolution - `POST /compose` interpolates and resolves
`inherit` auth, and every client executes the composed result
(`engine/src/http/request_composer.cpp`). The renderer keeps a **preview-only**
copy of the same rules (`app/src/lib/variable-resolution.ts`, consumed by
`useVariableResolver`) for tab titles, previews and the unresolved-token
painting. The rules on this page are the contract both implement, pinned by
the shared conformance fixture
(`engine/tests/fixtures/variable-resolution-conformance.json`), which the
engine's gtest suite and the renderer's vitest suite both drive.

**Malformed stored data (the D17 rules, decided in #226).** A definition whose
`enabled` is **absent** (or not a boolean) counts as **enabled** - only an
explicit `enabled: false` disables. A **non-string stored `value`** reads as
the empty string. One rule, both sides: the engine enforces it in
`parse_variables`, the renderer in `lib/variable-resolution.ts`, and the
fixture varies both fields so a divergence cannot hide.

## Priority order (lowest → highest)

```
Globals  <  Collection chain (root → leaf)  <  Active environment
```

A variable set in the active environment always wins over a collection variable, which
always wins over a global.

---

## Layers

### 1. Globals

App-wide variables stored in the singleton `globals` table. Edited via the Globals panel.
These form the base layer - any layer above can override them.

### 2. Collection chain

Each collection can define its own variables. When a request belongs to a nested
collection (e.g. `Root → API → Users`), variables are merged walking **root-first**:

```
Root.variables   →  applied first
API.variables    →  overrides Root
Users.variables  →  overrides API  ←  request's direct parent
```

This means a child collection's variable always takes precedence over an ancestor's
variable of the same name.

### 3. Active environment

The environment selected in the variables store (top of the sidebar). Environment
variables override everything else. This is the intended override point for
per-environment values like base URLs and API keys.

---

## Implementation

`useVariableResolver` (`app/src/hooks/useVariableResolver.ts`) collects **every**
definition of every name on every render via `useMemo`, keyed by
`(collectionId, environmentId)`, in precedence order (lowest first):

```typescript
// 1. Globals - a singleton, so no source name
for ([key, val] of globalsData.variables) push(key, val, "global");

// 2. Collection chain - root first so leaf overrides parent. Each collection is
//    its own origin: two in one chain both have scope "collection".
const chain = buildCollectionChain(activeCollectionId, collections); // root-first array
for (const col of chain)
  for ([key, val] of col.variables)
    push(key, val, "collection", { id: col.id, name: col.name });

// 3. Environment - highest priority
for ([key, val] of env.variables)
  push(key, val, "environment", { id: env.id, name: env.name });

// The winner is the last *enabled* definition.
```

`buildCollectionChain(startId, collections)` walks `parentId` links upward and
returns the chain with the root at index 0.

The resolved `Record<string, ResolvedVariable>` is **derived** from that list
(the origin carrying `winner: true`) rather than built beside it, so the two
cannot disagree about which definition won. A name whose every definition is
disabled is absent from the map, not present-and-empty - `hasUnresolvedVariables`
and the red token both key off absence.

### `getVariableOrigins(name)`

Returns every definition of a name, lowest precedence first, **including the
disabled ones that never resolve**. Empty array for a name nothing defines.

Display-only; nothing about execution reads it. It exists because the winner
alone cannot answer "why is this the value?" - and the two cases that need
answering are exactly the ones a flat map destroys:

- the same name defined at several scopes, where the losers were overwritten;
- a name whose highest-scope definition is **disabled**, which is the more
  common surprise. The old loop skipped those with `if (v.enabled)`, so nothing
  could report that the value you set is being *skipped* rather than missing.

The variable popover renders this as its "also defined" list. `VariableOrigin`
carries `enabled` and an explicit `winner` flag - once disabled definitions are
in the list, "last" and "wins" are different things.

`ResolvedVariable.sourceId` / `sourceName` name the specific environment or
collection the winning value came from (absent for `global`), so the popover can
say *which* environment rather than just "Environment".

### The engine implementation

`engine/src/http/request_composer.cpp` is the execution-time implementation of
this page (`build_variable_values` + `resolve_template`), reached through
`POST /compose`. It has no `getVariableOrigins` analogue - the origins list is
display metadata, and execution has no use for losers. MCP no longer carries a
copy at all: it composes via the engine and its old `resolve.ts` port is
deleted (#226).

The resolved map is then used by `resolveString(input)` (preview) and
`resolve_template` (engine) which replace all `{{name}}` occurrences. An
ordinary name nothing defines resolves to the **empty string** - the token
disappears from the outgoing request. A `{{$name}}` is the exception; see
below. Resolution is a **single pass**: a value that itself contains
`{{other}}` stays literal, and there is no way to escape a literal `{{`.

---

## Dynamic variables

A name starting with `$` is not looked up in any scope. It names a **generator**
in `app/src/lib/dynamic-variables.ts`, called where it is written:

| Name | Value |
|---|---|
| `$guid`, `$randomUUID` | UUID v4 |
| `$timestamp` | Unix time in seconds |
| `$isoTimestamp` | ISO 8601 UTC timestamp |
| `$randomInt` | integer 0 - 1000 |
| `$randomAlphaNumeric` | one alphanumeric character |
| `$randomBoolean` | `"true"` or `"false"` |
| `$randomEmail` | email address |
| `$randomFirstName`, `$randomLastName`, `$randomFullName` | person name |
| `$randomCompanyName` | company name |
| `$randomUrl` | absolute `https://` URL |
| `$randomIP` | IPv4 address |
| `$randomPassword` | 15-character password |

They resolve anywhere `{{name}}` does - URL, headers, body, form fields - and the
`{{` autocomplete offers them under a **Dynamic** heading in both the plain
fields and the body editors.

Three rules decide what happens at a token:

1. **Scopes win.** A workspace that defines a variable literally named `$guid`
   keeps that value; only a name nothing defines reaches a generator. So adding
   this table cannot change what an existing request sends.
2. **One value per occurrence.** Two `{{$guid}}` in one body are two different
   ids, which is the reason to write them. The table holds functions, not
   precomputed values.
3. **An unknown `$name` keeps its braces.** `{{$randomInteger}}` (not a name
   Vayu has) is sent as that literal text rather than resolving to `""`. The `$`
   is a declaration of intent, and a typo that silently emptied a field is the
   defect this feature was added to fix - so it is left where it can be seen, and
   the token stays marked unresolved in the UI.

### What this does not cover

**Scripts.** `pm.variables.get("$guid")` does **not** work. Interpolation
happens at compose time, strictly before any script runs, and script *text* is
never interpolated - a `{{…}}` inside a script is user JavaScript, and
rewriting it could not tell a string literal from code (#226, D16). Generating
a value in a script means writing the JavaScript for it. Now that resolution
is engine-side the machinery for `pm.variables.get("$guid")` / `replaceIn()`
exists, but wiring it into the sandbox is deliberately separate work. See
[pm API compatibility](./pm-api-compatibility.md).

**Load runs generate once, not per iteration.** A run's request half is
composed once (`POST /compose`) and then handed to the engine, which repeats
it - so every request in the run carries the *same* `{{$guid}}`. The load-test
dialog says so when the request contains one. Per-iteration values would mean
interpolating on the load generator's hot path (which targets 60k+ RPS), and
were deliberately kept out of #226's scope.

### The engine copy of the table

`engine/src/http/request_composer.cpp` carries the C++ generator table that
actually executes; the renderer's `lib/dynamic-variables.ts` drives
autocomplete and preview. **The two must list the same names**: the
conformance fixture pins the name set, and both suites compare their table
against it, so a name added to one side fails the other side's suite. (MCP's
`dynamic-variables.ts` copy is deleted - MCP composes via the engine.)

---

## Auth inheritance

When a request's auth mode is `"inherit"`, Vayu walks the collection ancestor chain
**leaf-first** (most specific wins) and uses the first collection that defines auth.
The walk that decides what is *sent* lives in the engine
(`request_composer.cpp::resolve_inherited_auth`, reached via `POST /compose`);
the renderer keeps `resolveAuthSource`
(`modules/request-builder/utils/auth-resolution.ts`) for the UI that *explains*
inheritance (`InheritanceChain`, `AuthInheritBanner`, the load dialog's OAuth
guard) - the two must agree on this walk:

```
Users auth  →  checked first  (leaf, most specific)
API auth    →  checked second
Root auth   →  checked last   (root, least specific)
```

Two collection modes mean "no credentials here" and the walk treats them
differently:

| Collection `auth.mode` | Meaning | Effect on the walk |
|---|---|---|
| `none` | nothing configured at this level | stepped over - keep climbing |
| `noauth` | configured to send nothing | **stops the walk** - the request sends no auth |

`noauth` exists because Postman's folder-level *No Auth* terminates inheritance,
and collapsing it into `none` meant an imported No Auth folder's requests silently
regained the parent collection's credentials. A collection *below* a `noauth` one
may still define its own auth - termination is about what is inherited, not a lock
on the subtree. Engine gtest (`request_composer_test.cpp`) covers the
terminator; an unresolved `inherit` that somehow reaches `POST /execute`
directly is treated as no auth and logged as a warning.

If no ancestor defines auth the request executes without auth.

Auth variable placeholders (e.g. `{{bearer_token}}`) are resolved through the
same variable map inside the winning block at compose time - deliberately
**before** any OAuth 2.0 token cache key is derived from the config, so two
environments whose configs differ only through `{{vars}}` never share a token.

---

## Script composition

Pre-request and post-request scripts run as one script assembled from the
collection chain plus the request's own, in order **root → leaf → request**:

```
Root.preRequestScript
API.preRequestScript
Users.preRequestScript
request.preRequestScript    ←  runs last
```

This lets a parent collection set up shared variables or auth tokens that child
requests and their own scripts can rely on.

The app builds the ordered list of script parts (empty or whitespace-only
scripts are dropped); the **engine** joins the surviving parts with a blank
line and runs the result. See `docs/engine/architecture.md` → *Request
composition boundary* for the wire shape.

### Reading a variable from a script

A script does not see `{{name}}` - those are resolved at compose time,
strictly **before** any script runs, and that includes the dynamic variables
above: `pm.variables.get("$guid")` is not a thing Vayu supports. A consequence
worth stating plainly (#226, decision D1): `pm.environment.set("token", …)` in
a **pre-request script cannot affect `{{token}}` in the same send's URL** -
the URL arrived already resolved. That is today's semantics preserved
deliberately; Postman resolves after the pre-request script, so this is a
known compatibility divergence. A script that must change what is sent edits
`pm.request` directly (the write-back is applied to the outgoing request).

A script reads a scope by name (`pm.environment.get`,
`pm.collectionVariables.get`, `pm.globals.get`) or reads across all three with
`pm.variables.get`, which walks **environment → collection → global** and stops
at the first scope that has the name enabled - this page's priority order, read
from the top down.

One difference to know about, kept deliberately in #226 (decision D2): the
script side has a single collection scope, and the engine fills it from the
request's **immediate parent collection only** (`execution.cpp`, where
`collectionVariables` is loaded). The chain merge described above applies to
`{{name}}` (at compose time), so a variable defined on an ancestor collection
is visible to `{{name}}` and *not* to `pm.collectionVariables.get` /
`pm.variables.get`. Closing the gap was considered and rejected for now:
scripts write `collectionVariables` back to the immediate parent
(`persist_script_variables`), so merging the chain into that scope would copy
ancestor variables down into the leaf collection on the next script write.
Read such a value from the environment or globals, or define it on the
request's own collection. See
[pm API compatibility](./pm-api-compatibility.md) and
[scripting.md](../engine/scripting.md#variables-pmvariables).

---

## Scope labels

`ResolvedVariable.scope` is a display hint used by the variable inspector:

| Value         | Meaning                        |
|---------------|--------------------------------|
| `"global"`    | Came from globals              |
| `"collection"`| Came from any collection layer |
| `"environment"`| Came from the active environment |
