# Postman Environment

Parses a Postman **environment** export - the separate `*.postman_environment.json` file Postman produces from _Environments → Export_ - into a Vayu environment. It is not the collection export; see [postman.md](./postman.md) for that.

- **Source:** `app/src/services/importers/postman-environment.ts`
- **Exports:**

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `PostmanEnvironmentParser` | `Postman Environment` | `postman-environment` |

Implements `ImportParser` (`detect` + `parse`) from `./types`.

## Detection

```ts
parsed._postman_variable_scope === "environment" && Array.isArray(parsed.values)
```

Both halves are required. The scope marker alone is not enough - Postman uses the same document shape for globals - and `values` must be an array, since it is walked directly.

`PostmanEnvironmentParser` is registered **third** in the factory's `PARSERS`, after the two collection parsers and before Insomnia:

```
PostmanV21 → PostmanV20 → PostmanEnvironment → InsomniaV4 → OpenApiV3 → OpenApiV2
```

That position is not load-bearing. An environment export carries neither `info` nor `item[]`, so `PostmanV20Parser`'s permissive fallback branch (`info` present + `item[]` array + no schema) cannot claim it, and no other detector looks at `_postman_variable_scope`. The grouping is for readability.

### Globals are deliberately not claimed

A `_postman_variable_scope: "globals"` file has the identical shape and would be trivial to route into Vayu's globals scope. It is left **unrecognised** on purpose: whether an import may write the globals scope at all is a product decision that has not been made ([#153](https://github.com/athrvk/vayu/issues/153)). A globals file therefore fails with `UnrecognisedFormatError` ("Unrecognised format") rather than landing somewhere the user did not ask for.

## Field mapping

| Postman | Vayu `EnvironmentDraft` | Notes |
|---------|-------------------------|-------|
| `name` | `name` | Falls back to `"Imported Environment"` when absent or empty. |
| - | `description` | Always `""`; the export has no description field. |
| `values[]` | `variables` | Via the shared `toVarRecord` helper. |

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
  environments: [ /* 0 or 1 */ ],
  meta: {
    format: "Postman Environment",
    requestCount: 0, folderCount: 0,
    environmentCount: environments.length,
    skipped: [], nonExecutableAuth: 0,
  },
}
```

### `importEnvironments`

Honored **at parse time**, matching `InsomniaV4Parser`: when the option is false the parser emits `environments: []` and `environmentCount: 0`, so the preview shows what will actually be created rather than what the file contains.

For this format that is the whole result, which puts two states on screen no other format reaches:

- **The preview renders environments.** `ImportModal`'s preview tree listed collections only, so an environment-only import previewed as an empty box. It now renders one row per environment (name + variable count) beneath the collection tree - for every format, not just this one.
- **Import is blocked when nothing would be created.** With `importEnvironments` off there is no collection and no environment, so importing would create nothing and close the modal - a silent no-op. The Import button is disabled and the preview says why. The toggle that recovers it is in the same footer, so the state is never a dead end.

`ImportOrchestrator.run` needed no change: its collection loop simply does not execute, and its environment creation was already gated on `opts.importEnvironments`.

## Not covered

- **Globals exports** - see above.
- **Workspace dumps.** Postman's _Export Data_ produces a directory of collection *and* environment files. Import takes one file at a time; each file in such a dump imports individually.

## Tests

- `app/src/services/importers/postman-environment.test.ts` - detection (including the globals and collection negatives), mapping, the secret flag, the empty-secret case, and the `importEnvironments: false` path.
- `app/src/services/importers/factory.test.ts` - routing, plus the guard that a collection export still reaches the collection parser.
- `app/src/modules/collections/ImportModal.environments.test.tsx` - the preview row, the blocked Import, and recovery via the toggle.
- Fixture: `app/src/services/importers/__fixtures__/postman-environment.json`.
