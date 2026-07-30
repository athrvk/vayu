# Variable Resolution

Vayu resolves `{{variableName}}` placeholders at request-execution time using a layered
priority system. Higher-priority layers override lower ones; within each layer the last
write wins.

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

### The MCP copy

`app/electron/mcp/resolve.ts` duplicates resolution for the MCP client and is
**deliberately not** given `getVariableOrigins`. The rule in `CLAUDE.md` is that
the two copies move together when *semantics* change; these have not - the
winner is still the last enabled definition in the same precedence order. The
origins list is display metadata, and MCP renders nothing.

The resolved map is then used by `resolveString(input)` which replaces all
`{{name}}` occurrences. Unresolved variables are left as-is (e.g. `{{unknown}}`
stays in the output rather than becoming an empty string).

---

## Auth inheritance

When a request's auth mode is `"inherit"`, Vayu walks the collection ancestor chain
**leaf-first** (most specific wins) and uses the first collection that defines auth.
The walk lives in `resolveAuthSource`
(`modules/request-builder/utils/auth-resolution.ts`) and is resolved in
`RequestBuilder` before sending to the engine:

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
on the subtree. The MCP server resolves auth the same way in
`electron/mcp/resolve.ts` (`composeAuth`); the two copies must change together.

If no ancestor defines auth the request executes without auth.

Auth variable placeholders (e.g. `{{bearer_token}}`) are resolved through the same
variable map before the value is sent to the engine.

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

A script does not see `{{name}}` - those are already resolved by the time the
payload reaches the engine. It reads a scope by name (`pm.environment.get`,
`pm.collectionVariables.get`, `pm.globals.get`) or reads across all three with
`pm.variables.get`, which walks **environment → collection → global** and stops
at the first scope that has the name enabled - this page's priority order, read
from the top down.

One difference to know about: the script side has a single collection scope, and
the engine fills it from the request's **immediate parent collection only**
(`execution.cpp`, where `collectionVariables` is loaded). The chain merge
described above is done app-side for `{{name}}`, so a variable defined on an
ancestor collection is visible to `{{name}}` and *not* to
`pm.collectionVariables.get` / `pm.variables.get`. Read such a value from the
environment or globals, or define it on the request's own collection. See
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
