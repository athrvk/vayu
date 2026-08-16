---
description: >-
  Importing Postman environment and globals exports into Vayu - keys, values, enabled state, secret flags, and how globals merge.
---

# Postman Environment and Globals

Parses the two variable exports Postman writes as standalone files, both from _Environments → Export_:

| Export | `_postman_variable_scope` | Lands in |
|---|---|---|
| Environment (`*.postman_environment.json`) | `"environment"` | A new Vayu environment |
| Globals (`*.postman_globals.json`) | `"globals"` | Vayu's globals scope, merged |

Neither is the collection export; see [postman.md](./postman.md) for that. The two share a document shape and therefore a parser, so the mapping rules cannot drift between them - only the destination differs.

- **Source:** `app/src/services/importers/postman-environment.ts`
- **Exports:**

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `PostmanEnvironmentParser` | `Postman Environment` | `postman-environment` |

Implements `ImportParser` (`detect` + `parse`) from `./types`.

## Detection

```ts
(parsed._postman_variable_scope === "environment" ||
	parsed._postman_variable_scope === "globals") && Array.isArray(parsed.values)
```

Both halves are required: `values` must be an array, since it is walked directly.

`PostmanEnvironmentParser` is registered **third** in the factory's `PARSERS`, after the two collection parsers and before Insomnia:

```
PostmanV21 → PostmanV20 → PostmanEnvironment → InsomniaV4 → OpenApiV3 → OpenApiV2
```

That position is not load-bearing. An environment export carries neither `info` nor `item[]`, so `PostmanV20Parser`'s permissive fallback branch (`info` present + `item[]` array + no schema) cannot claim it, and no other detector looks at `_postman_variable_scope`. The grouping is for readability.

### Globals merge, they do not replace

`POST /globals` **replaces** the whole set - the engine has no merge verb (see [api-reference.md](../../engine/api-reference.md#post-globals)). Writing the imported record straight to it would delete every global the user already had, so `ImportOrchestrator.applyGlobals` reads the current set first and writes the union.

On a name collision **the imported value wins**. The user explicitly asked for this file's variables, and silently keeping the old value would be the no-op outcome this import path exists to avoid. The preview states it: *"Existing globals are kept; a variable of the same name is overwritten."*

Globals are written **last**, after the bulk `POST /import/apply` has landed and its id-map has been checked. That ordering is load-bearing: it is the one write here that can destroy data the import did not create, so nothing may fail behind it. A failed apply therefore never leaves globals half-rewritten.

Globals are **not** part of the `/import/apply` payload - they are an engine singleton with no temp id, not a tree item - so they remain a second request, and that is the one partial outcome the import still has: the tree lands, the globals write fails, and the error surfaces. There is no rollback to undo an atomic apply that already succeeded (see [README.md](README.md#3-persist---orchestratorts)).

A globals export carries a `name` (the workspace's). Vayu's globals scope is a singleton with nowhere to put it, so it is dropped rather than invented into an environment name.

## Field mapping

| Postman | Vayu | Notes |
|---------|------|-------|
| `name` | `EnvironmentDraft.name` | Environment scope only. Falls back to `"Imported Environment"` when absent or empty; **dropped** for a globals export. |
| - | `EnvironmentDraft.description` | Always `""`; the export has no description field. |
| `values[]` | `variables` / `ImportResult.globals` | Via the shared `toVarRecord` helper, identically for both scopes. |

### `values[]` → `variables`

`toVarRecord` (`shared.ts`) is the same helper Postman **collection** variables go through, so the rules are shared rather than re-derived:

| Postman entry field | Effect |
|---|---|
| `key` | The record key. An entry with a falsy `key` is **dropped**. |
| `value` | `asString` then `normalizeVars`, so `{{ user.name }}` tightens to `{{user.name}}` like every other parser. |
| `enabled` / `disabled` | `disabled` wins if present, else `enabled`, else `true`. |
| `type === "secret"` | Sets `secret: true`. Any other `type` omits the flag entirely (not `secret: false`). |

Postman's other `type` values describe a value kind Vayu does not store - every variable value is a string - so only `"secret"` is read.

**Empty secret values are imported, not skipped.** Some Postman export paths blank out secret-typed values. The variable is still created (empty, enabled, `secret: true`) so the key stays visible for the user to fill in; dropping it would lose the name too, with nothing on screen to say so.

## Result shape

```ts
{
  collections: [],            // the only parser that produces none
  environments: [ /* 0 or 1; always 0 for a globals export */ ],
  globals: { /* {} unless a globals export */ },
  meta: {
    format: "Postman Environment" | "Postman Globals",
    requestCount: 0, folderCount: 0,
    environmentCount: environments.length,
    globalCount: Object.keys(globals).length,
    skipped: [], nonExecutableAuth: 0,
  },
}
```

`ImportResult.globals` is a plain `Record<string, VariableValue>`, not a draft list: globals are a singleton on the engine, so there is nothing to name and no id for `assignIds` to stamp. It is a **required** field on `ImportResult`, so every parser states its answer (`{}` for all but this one) rather than leaving the destination implicit.

`meta.format` is per-document rather than the parser's `formatName`, since one parser now covers two exports the user sees differently.

### `importEnvironments`

The one toggle governs **both** scopes - it reads "Import environments & variables", and globals are variables. No separate control was added.

Honored **at parse time**, matching `InsomniaV4Parser`: when the option is false the parser emits `environments: []`, `globals: {}` and zeroed counts, so the preview shows what will actually be created rather than what the file contains.

For this format that is the whole result, which puts two states on screen no other format reaches:

- **The preview renders environments and globals.** `ImportModal`'s preview tree listed collections only, so an environment-only import previewed as an empty box. It now renders one row per environment (name + variable count) beneath the collection tree, plus a single **Globals** row when the import carries any - named for the destination scope, since a globals export has no name of its own worth showing. This is for every format, not just this one.
- **Import is blocked when nothing would be created.** With `importEnvironments` off there is no collection, no environment and no globals, so importing would create nothing and close the modal - a silent no-op. The Import button is disabled and the preview says why. The toggle that recovers it is in the same footer, so the state is never a dead end.

`ImportOrchestrator.run` gained `applyGlobals` (above); its collection loop simply does not execute, and environment creation was already gated on `opts.importEnvironments`. `useImportMutation` also invalidates `queryKeys.globals.all`, without which the imported variables would sit on the engine unread until the next reload.

## Not covered

- **Workspace dumps.** Postman's _Export Data_ produces a directory of collection *and* environment files. Import takes one file at a time; each file in such a dump imports individually.

## Tests

- `app/src/services/importers/postman-environment.test.ts` - detection for both scopes (and the collection negative), mapping, the secret flag, the empty-secret case, the dropped workspace name, and the `importEnvironments: false` path for each scope.
- `app/src/services/importers/factory.test.ts` - routing for both exports, plus the guard that a collection export still reaches the collection parser.
- `app/src/services/importers/orchestrator.test.ts` - the merge, the collision rule, that a result with no globals neither reads nor writes the scope, the `importEnvironments: false` skip, that a failed apply never reaches the globals write, that a failed globals write surfaces with the tree already committed, and the globals-last ordering.
- `app/src/queries/import.test.ts` - `getGlobals` / `updateGlobals` delegation and the globals cache invalidation.
- `app/src/modules/collections/ImportModal.environments.test.tsx` - the preview rows for both scopes, the merge notice, the blocked Import, and recovery via the toggle.
- Fixtures: `app/src/services/importers/__fixtures__/postman-environment.json`, `postman-globals.json`.
