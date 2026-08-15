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

**One matcher in the renderer.** `{{name}}` is recognised by
`VARIABLE_PATTERN` in `app/src/constants/variables.ts` and nowhere else -
import it (or `containsVariableToken` / `isVariableToken`, which wrap the two
boolean questions) rather than writing the literal again. The app had four
identical copies before issue #227, and copies are how a preview drifts from
what `/compose` will substitute without anything failing. The C++ side is the
one legitimate other copy, and the conformance fixture is what holds it to
this one. `constants/variable-pattern-single-source.test.ts` fails on a fifth.

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

### `data.*` is reserved, and sits outside this order

`{{data.column}}` addresses a column of a collection run's data file (issue
#402), and it is **not a fourth tier above the three**. It is a reserved
namespace, disjoint from them: `{{data.id}}` and `{{id}}` are different names,
so a data set can neither shadow nor be shadowed by a variable, and attaching a
data file to a collection cannot change what its other tokens resolve to. That
is what dissolves the precedence question rather than answering it.

Nothing in the tables above resolves such a token. Both resolvers - the
engine's `resolve_template` and the renderer's `resolveTemplate` - leave it
written exactly as it stands, because only a scenario run's iteration knows
which row is bound; the run's worker substitutes it immediately before each
send. A `data.*` token in an ordinary Send therefore reaches the wire as
written: there is no row. `{{data.}}` with nothing after the dot names no column
and follows the ordinary unknown-name rule (resolves to `""`) instead.

**The UI paints it as its own state, not as a broken variable.** Unresolved is
the accurate word for what the resolvers do with the token, but it is the wrong
thing to *show*: the builder used to render `{{data.email}}` red, hover it to
"not defined", and offer to create a variable of that name - which, the
namespace being disjoint, can never answer for the column. So a `data.*` token
gets the muted run-time treatment (`RuntimeToken`) and a tooltip naming the run's
data file, and no surface offers to create one. See
[COMPONENTS.md](COMPONENTS.md#shared-variable-input-componentssharedvariableinput)
for the three token states.

A **collection run** is the one place that reading is not left to the user: a
run started without a data file whose plan still carries a `data.*` token is
refused with a `400` naming the step and the token, rather than sending the
literal text once per iteration (issue #415). The single Send above keeps its
behaviour - a token someone typed into a request they are editing is not yet a
run.

The conformance fixture pins all three cases, so the two resolvers cannot
drift on them. See
[api-reference.md](../engine/api-reference.md#scenario-runs) for what the
engine does with the token once a row exists.

### Which contract answers for a request: nearest declared ancestor

A collection can **declare** the columns its data files carry (the Data tab,
issue #599). Which declaration applies to a given request is a chain answer, and
the rule is the variable chain's own read backwards: **the nearest declared
ancestor, leaf to root** (`resolveDataContract` in `lib/data-contract.ts`). A
request in a sub-collection run recursively under a parent binds the parent's
data, so when the sub-collection declares nothing the walk finds the parent's
contract - and when it declares its own, its own wins, exactly as a leaf
variable shadows an ancestor's.

A collection that declared a contract and then cleared it holds `{}`, which is
how "no contract" is spelled, so the walk treats it as transparent rather than
as a contract of zero columns - an empty declaration cannot shadow a working one
above it.

This is what makes the token states possible: with a contract in scope,
`{{data.email}}` is *checkable*. A declared column paints informationally, a
column no contract in scope declares paints **amber** with the declared list in
its tooltip, and a chain that declares nothing keeps the neutral token above. It
is authoring-time advice in every case - the run's file is the authority, and a
run with a mismatched file is still the user's to start. Declared columns are
also completed: `{{data.` offers them in the request fields and the body editors,
and `pm.iterationData.get("` offers them in the script editors (see below).

The script panel's **"Referenced:" chips** read the same three states (issue
#604). They used to paint a name red whenever no scope defined it, which for a
`data.*` name is always - the reading that made a working column look broken in
a row whose whole job is to say whether a name resolves.

The **audit** in the Data tab is the same comparison in the other direction -
the declared columns against the tokens the collection's requests actually
carry. See
[COMPONENTS.md](COMPONENTS.md#shared-variable-input-componentssharedvariableinput)
for the paint and
[Data-Driven Runs](data-driven-runs.md) for the file itself.

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
returns the chain with the root at index 0. It keeps a `seen` set and stops on
a revisit: the engine rejects parent cycles on write (issue #79), so a cycle
means the database already went bad, and the walk runs inside a `useMemo` -
an unterminated one is a frozen window, not a wrong preview.

**Collection scope is explicit only.** It comes from the `collectionId` option
and nothing else; a caller that passes none resolves against globals +
environment. There used to be a session-store fallback (`activeCollectionId`),
but nothing ever wrote that field, so it could only ever hold a value
rehydrated from an old build - scoping a preview to a collection the user had
left, or deleted, versions ago. It was removed in the `vayu.session` v2
migration.

The resolved `Record<string, ResolvedVariable>` is **derived** from that list
(the origin carrying `winner: true`) rather than built beside it, so the two
cannot disagree about which definition won. A name whose every definition is
disabled is absent from the map, not present-and-empty - the red token keys off
absence, so a present-and-empty entry would paint it resolved and send "".

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

**An edit writes back to that source, never to one re-derived.** The context bar
commits against `sourceId`, so the definition that receives the value is the one
the bar displayed. It used to walk the collection chain itself for the first
definition with a truthy `enabled`, which disagrees with the resolver's
`isEnabledDefinition` on every definition where `enabled` is *absent* (D17 counts
absent as enabled) - so a leaf definition without the key displayed while an
ancestor's took the write. Any second implementation of "which definition wins"
can drift from this one; there is only meant to be the one, and `sourceId` is how
it is carried.

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

**Script text.** A `{{…}}` written directly in script *code* does not resolve
and never will - it is user JavaScript, and rewriting it could not tell a
string literal from code (#226, D16). What a script uses instead is
**`pm.variables.replaceIn("{{$guid}}")`**: the same engine resolver, run at
call time over a string the script opts in - dynamic variables included, one
value per occurrence. `pm.variables.get("$guid")` (getter fall-through to the
generators) is deliberately not wired. See
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

The collection scope a script reads is the **whole chain**, the same one
`{{name}}` merges (issue #234; `load_script_variable_scopes` in
`execution.cpp` builds it from `collection_chain`). A variable defined on an
ancestor collection therefore reads the same in `pm.collectionVariables.get`,
`pm.variables.get` and `pm.variables.replaceIn("{{name}}")` as it substitutes
in the URL.

**Reads walk the chain; writes stay on the leaf.** `set`, `unset` and `clear`
only ever touch the request's own collection - the one
`persist_script_variables` writes back. So the rule for an inherited name is
CSS-like:

- `pm.collectionVariables.set("token", x)` on a descendant **shadows** the
  ancestor's `token`; the ancestor's stored value is untouched.
- `pm.collectionVariables.unset("token")` removes the descendant's copy, and
  `get("token")` then finds the ancestor's value again.
- `pm.collectionVariables.clear()` empties the request's own collection only.

Inheritance can be shadowed from below, never deleted from below. That
asymmetry is the point rather than an oversight: #226 (decision D2) originally
kept the whole chain out of scripts precisely because a single merged,
writable map would have let one `set()` copy every ancestor's variables down
into the leaf collection on the next persist. Read-only ancestors make that
impossible while still answering the read. A disabled row is looked past
wherever it sits, so unticking an inherited name in a descendant falls through
to the ancestor's value rather than hiding it. See
[pm API compatibility](./pm-api-compatibility.md) and
[scripting.md](../engine/scripting.md#variables-pmvariables).

#### Autocomplete inside the accessors

The script editors complete variable **names** inside the string argument of a
`pm.*` accessor - `pm.environment.get("…")`, and the `set` / `has` / `unset`
spellings beside it (`useScriptVariableCompletionProvider`). The `{{name}}`
list is deliberately *not* registered for `javascript`: braces are not the
syntax in a script, so offering them there would teach the wrong thing. The
names are the same names; only the place you type them differs.

Three rules make the offered set match what the call can actually read:

- **The accessor picks the scope.** `pm.environment.get` lists environment
  variables only, because that is the one scope it reads - a collection
  variable offered there would be a name that returns `undefined`. Only the
  merged `pm.variables.get` lists all three.
- **Collection variables come from the active tab.** Collection scope is
  explicit-only (see *Collection scope is explicit only* above) and a Monaco
  completion provider is registered once per *language*, not per editor, so it
  has no request builder context to take a `collectionId` from. Both providers
  get one from `useActiveCollectionId` instead - the active tab's request's
  collection, or a collection tab itself - so the list is globals + the
  collection chain + the active environment, the same set every other surface
  offers.
- **The script list carries the same chain.** The engine walks the collection
  chain for scripts too (#234), so an ancestor's variable is offered inside
  `pm.collectionVariables.get()` and the merged `pm.variables.get()` - it is a
  name the call can read. This list narrowed to the immediate collection while
  the engine did; the rule underneath is unchanged, which is that the list
  offers exactly what the call resolves.
- **`pm.iterationData` completes columns, not variables.** The row it reads is
  bound from the collection's data file, so the names offered inside
  `pm.iterationData.get("…")` and `.has("…")` are the declared columns of the
  contract in scope (issue #600) - the same list the `{{data.*}}` tokens are
  painted against, so an editor and the builder cannot disagree. Optional
  chaining counts as the dot it is (`pm.iterationData?.get("`), because the
  surface is `undefined` outside a data-driven run or a send-with-row, and its own documentation
  tells scripts to guard before calling. Nothing is offered when the chain
  declares no contract.
- **Generators belong to `replaceIn` alone.** `pm.variables.replaceIn` takes a
  template and interpolates it, so it gets brace-style completion including
  `{{$guid}}`; `pm.variables.get("$guid")` is not a lookup that resolves, so no
  generator is offered there.

The dotted `pm.*` completions (served by the engine, see
[the scripting docs](../engine/scripting.md)) yield inside a string literal so
the two lists never appear together.

---

## Scope labels

`ResolvedVariable.scope` is a display hint used by the variable inspector:

| Value         | Meaning                        |
|---------------|--------------------------------|
| `"global"`    | Came from globals              |
| `"collection"`| Came from any collection layer |
| `"environment"`| Came from the active environment |
