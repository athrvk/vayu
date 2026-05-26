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
These form the base layer — any layer above can override them.

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

`useVariableResolver` (`app/src/hooks/useVariableResolver.ts`) builds a flat
`Record<string, ResolvedVariable>` on every render via `useMemo`, keyed by
`(collectionId, environmentId)`:

```typescript
// 1. Globals
for ([key, val] of globalsData.variables) result[key] = { value, scope: "global" };

// 2. Collection chain — root first so leaf overrides parent
const chain = buildCollectionChain(activeCollectionId, collections); // root-first array
for (const col of chain)
  for ([key, val] of col.variables)
    result[key] = { value, scope: "collection" };

// 3. Environment — highest priority
for ([key, val] of env.variables)
  result[key] = { value, scope: "environment" };
```

`buildCollectionChain(startId, collections)` walks `parentId` links upward and
returns the chain with the root at index 0.

The resolved map is then used by `resolveString(input)` which replaces all
`{{name}}` occurrences. Unresolved variables are left as-is (e.g. `{{unknown}}`
stays in the output rather than becoming an empty string).

---

## Auth inheritance

When a request's auth mode is `"inherit"`, Vayu walks the collection ancestor chain
**leaf-first** (most specific wins) and uses the first collection whose auth mode is
not `"none"`. This is resolved in `RequestBuilder` before sending to the engine:

```
Users auth  →  checked first  (leaf, most specific)
API auth    →  checked second
Root auth   →  checked last   (root, least specific)
```

If no ancestor has non-none auth the request executes without auth.

Auth variable placeholders (e.g. `{{bearer_token}}`) are resolved through the same
variable map before the value is sent to the engine.

---

## Script composition

Pre-request and post-request scripts are composed from the collection chain plus the
request's own script before execution. Scripts run **root → leaf → request**:

```
Root.preRequestScript
API.preRequestScript
Users.preRequestScript
request.preRequestScript    ←  runs last
```

This lets a parent collection set up shared variables or auth tokens that child
requests and their own scripts can rely on.

Empty scripts are omitted; non-empty scripts are joined with a blank line between them.

---

## Scope labels

`ResolvedVariable.scope` is a display hint used by the variable inspector:

| Value         | Meaning                        |
|---------------|--------------------------------|
| `"global"`    | Came from globals              |
| `"collection"`| Came from any collection layer |
| `"environment"`| Came from the active environment |
