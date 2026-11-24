---
description: >-
  The shared key/value editor of the Vayu desktop app: the table behind params, headers and form bodies.
---

# Shared Key/Value Editor (`components/shared/KeyValueEditor/`)

`index`, `KeyValueRow`, `FilePartCell`, `grid.ts`, `key-value.ts` - the app's key/value
table (params, headers, form fields, and a webhook inbox's canned reply
headers).

**Resolution is an input, not an ambient dependency:** the optional `variables`
prop carries the [`VariableSupport`](shared-variable-input.md#variable-scope-as-a-prop-variablesupport)
scope, and with it omitted the table resolves nothing, shows no `ResolvedPeek`
and offers no `{{` autocomplete - the correct reading of a surface with no
variables. That is what lets it mount outside `RequestBuilderProvider`; before
it, `KeyValueRow` called the context hook in its body and that hook *throws*
with no provider, so every other surface hand-rolled its own rows (issue #564).

**The Σ peek hides a secret variable's value** (#1810). It prints the row's
resolved text, so `token={{secretVar}}` would show the secret on Params, Headers
and both Body tables. `ResolvedPeek` applies `variables.maskSecrets` to the text
it draws and to nothing else: the cached resolution (`stableRowField`) and
`hasVariables` keep the real value, and the trigger's `aria-label` is built from
the row's unresolved key, so it never carried one. A scope without `maskSecrets`
(a surface with no variables) shows the text as is. `KeyValuePeek.secrets.test.tsx`
renders each table through its real panel.

**The Σ peek leaves a deferred name written** (#2762). A name `POST /compose`
lists in `deferredVariables` is set by a pre-request script at send, so the
stored value is not what the row sends. `RequestBuilderProvider` hands the table
a `resolveField` that leaves such a `{{name}}` as written (`leaveDeferredField`,
`utils/sends-url.ts`, memoised per resolver and set of names so
`stableRowField`'s identity check still holds and a `{{$randomInt}}` does not
reroll), and `KeyValueRow` reads `variables.deferredVariables` itself for the
names its key and value use (`deferredNamesIn`): `hasVariables` stays true for a
row whose only token is deferred, so it keeps its marker, and `ResolvedPeek`
puts `deferredNote` in the tooltip's `hint` slot, on a line of its own beneath
any refusal. Every table behind `variables` gets it with no per-table code,
OAuth 2.0 token-request rows included; the Body tab's Resolved pane reads the
same `resolveField` and puts the sentence under its text
(`KeyValueRow.deferred.test.tsx`, `RequestBuilderProvider.deferred-previews.test.tsx`).

**`fieldContext` says what kind of field the rows are** (issue #2639): `header`
for the Headers tab, `plain` (the default) for every other table, as the
engine's bind treats them. Each row resolves its key and value through
`variables.resolveField` with it, so with a data row picked a cell bound into a
header that carries a line break previews as its token, and the peek opens with
the send's refusal under the text (`TooltipValue`'s hint line). A refusal names
the token, never the cell. The context is fixed into one resolver per
`resolveField` and context (`resolverFor`), because `stableRowField` checks its
resolver by identity. `bound-row-escaping.test.tsx` renders the Headers and Body
panels with the real resolver holding a row.

`allowFiles` (form-data only) turns each row into a text/file switch and stays
on this table rather than the caller, since only the request builder has a wire
format that can carry a file; `FilePartCell` is the value cell of a file part -
it picks a file, shows the path, and marks one the engine would refuse or has
not answered for yet (`unresolved` not `false`; a pick sets `false` until the
next read, and a part that names no file is not marked: there is no path to
doubt). The picking itself - the hidden input, and a `File` turned into the
path the preload reports - is `components/shared/file-pick.ts`, shared with the
binary body editor. `lib/file-path.ts` holds the basename rule it shares with the
importers, and the parent-folder and under-a-folder rules the binary editor and
the import preview use.

The **variables table is deliberately not a consumer.** `modules/variables/main/VariableTableEditor.tsx` keeps its own rows for the reasons recorded in [Variables](variables-and-settings.md#variables-modulesvariables); the parity it must hold with this table anyway is guarded by `key-value-parity.test.tsx`, not by hand.

The per-row gates are per field (`canEdit(item, "key" | "value")`), and the enable box answers to `canDisable` alone, not to the key's lock: the Params tab's path-variable table (issue #1764) locks the key, which the URL owns, and still lets the user switch the row off.

**`KeyValueRow` is `memo`-wrapped, so the table's callback identities are what decide which rows repaint on a keystroke** (issue #1716). `handleRemove`, `handleUpdate`, `handlePickFile`, `handleToggleKind` and `handleReplace` in `index.tsx` do not list `items` in their `useCallback` deps - `onChange` rewrites `items` to a fresh array on every keystroke, so a dep on `items` would give all five callbacks a new identity every keystroke and fail every row's shallow prop compare, however many rows a single edit actually touched. Each callback instead reads the current list through a ref (`itemsRef`, kept in step by a `useEffect`), so their deps are `[onChange, canEdit]`/`[onChange, canRemove]`/`[onChange, canEdit, canDisable]` only - stable as long as the caller's `canEdit`/`canRemove`/`canDisable` are - and only the row whose own `item` changed re-renders. The `canEdit`/`canRemove`/`canDisable` defaults are module constants for the same reason: an inline arrow in the parameter list is a fresh function every render, which would defeat the ref-backed callbacks exactly as a dep on `items` did for any caller that leaves them unset. **The caller's `onChange` is part of the same rule**: it is also a dep, and every keystroke rewrites the caller's own state. `ParamsPanel`'s two handlers therefore read `request.params`, `request.url` and `request.disableUrlEncoding` through a ref (`latest`) and list only `updateField`; `ParamsPanel.render-count.test.tsx` pins it.

`grid.ts` holds the table's **column track** (`KEY_VALUE_GRID` and its `_WITH_FILES` / `_WITH_EXTRA` variants) so the header band, `KeyValueRow` and the request builder's read-only "Added by Vayu" rows in `HeadersPanel` cannot drift apart (#2071); it is a module of its own because the editor imports the row.

**`rowExtra` is an opt-in column for a caller's own per-row control** (issue #2571): `{ header, render(item, { replaceItem, disabled }) }`. A table that passes none keeps the track, header band and cells it had (`row-extra.test.tsx` pins it), so Params, Headers, form-data, urlencoded and the inbox are unchanged. With it, `keyValueGrid(allowFiles, true)` adds a 7rem column after the value on the header band and every row. The control writes by handing back the whole row (`replaceItem`), because the table's own `handleUpdate` knows only the fields of a `KeyValueItem`; `handleReplace` keeps the row's `id` and answers to `canEdit(item, "value")` like a file pick. The trailing spare row gets an empty cell, and `disabled` is true for a switched-off row, a read-only table or a locked value. `render` reaches the `memo`-wrapped `KeyValueRow`, so the caller keeps its identity stable (#1716). Its one user is [`ParamRowsEditor`](shared-response-viewer.md#shared-oauth-20-form-componentssharedoauth2form).

`key-value.ts` is the table's **row model**: `toKeyValueItems` /
`toKeyValueEntries` convert between the domain `FormFieldEntry[]` and the
UI-layer `KeyValueItem[]` (which adds the ephemeral `id` React keys need), and
`withTrailingBlank` is the one definition of the spare row at the bottom.
**Row identity** is the id, and every conversion from storage mints new ones, so
a caller that reconverts a refetched table has two more rules here (#3663):
`sameRows` says whether two tables store the same rows (compared as their
entries, member by member, ids and blank rows out), and `carryRowIds` hands a
refetched table the ids of the current rows it restates, by content and in
order, with the spare row keeping the current spare row's id; `carryIds` is the
generic claim-each-once rule under it, which `parseParamsFromText` uses too. A
fresh id is a remount: the row's inputs are replaced and the caret goes to
`<body>`. The request builder's merge uses both (see
`docs/app/state-management/draft-hooks.md`). It
moved here from `modules/request-builder/utils/` with the table (issue #567),
because a second mount site needs the same conversion and a primitive cannot
take it from a feature module. What stayed in the request builder is what no
table asks for: `toHeaderRows` (execution-shaped) and the managed system
headers. `KeyValueItem` and `KeyValueEditorProps` live in `types/ui.ts` for the
same reason - there is deliberately **no re-export shim** in
`modules/request-builder/types.ts`, so each name has one import path.
