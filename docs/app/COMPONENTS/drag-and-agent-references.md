---
description: >-
  The shared drag primitives and the agent-reference helpers of the Vayu desktop app (lib/drag/, lib/agent-reference.ts).
---

# Drag Primitives and Agent References

## Drag primitives (`lib/drag/`, `components/shared/DropIndicator.tsx`)

What a drag surface shares without sharing a DOM. The collection tree and the tab strip (`useTabStripDnd.ts`, issue #2039) both import them; the files sit outside `modules/collections/` so a surface imports them rather than copying them.

| File | Role |
|---|---|
| `lib/drag/drag-gesture.ts` | Press versus drag, and the trailing click. [Details](#libdragdrag-gesturets) |
| `lib/drag/drop-slot.ts` | Where a drop lands in a one-dimensional list: `slotAt` and `landingIndex`. [Details](#libdragdrop-slotts) |
| `components/shared/DropIndicator.tsx` | The 2px `--primary` line a drag draws at the edge it would drop on, `horizontal` or `vertical`. [Details](#componentsshareddropindicatortsx) |

### `lib/drag/drag-gesture.ts`

Press versus drag, and the trailing click.
A pure state machine over pointer coordinates: below the ~4px threshold a press is still a click (the row opens synchronously, which the hit-area guards pin), and a completed drag swallows exactly one following click - the one that would otherwise open the row that was just dropped

### `lib/drag/drop-slot.ts`

Where a drop lands in a one-dimensional list: `slotAt` (the number of items whose midpoint is before the pointer), `landingIndex` (the index the item ends up at once lifted out of its old place; a drop whose landing index equals the item's own is a no-op).
Pure and node-tested; throws on a non-integer or negative index.
The tab strip uses it; the collection tree does not - its drops resolve against a parent and an anchor row (`drop-position.ts`, `useTreeDnd.ts`'s `indexAmongSiblings`)

### `components/shared/DropIndicator.tsx`

The 2px `--primary` line a drag draws at the edge it would drop on, `horizontal` (across a row, indented by `indentPx`) or `vertical` (down the side of an item, as in the tab strip).
`aria-hidden`, `pointer-events-none`, and `data-drop-indicator` carries the edge.
The host must be `relative`.
The tree's `RowDropIndicator` delegates to it

## Agent references (`lib/agent-reference.ts`)

The one place the app words an entity for an agent (#2046): `Vayu <kind> "<name>" (<id>)` plus a tail, one
exported formatter per kind (`requestReference`, `exampleReference`, `collectionReference`,
`environmentReference`, `runReference`, `runComparisonReference`, `inboxReference`, `captureReference`,
`mockServerReference`, `mockIssuerReference`, `trashReference`, `variableReference`, `specOperationReference`,
`graphqlOperationReference`, `runSampleReference`, `elementReference`, `thresholdReference`). **A reference carries no value:** each
formatter takes a `Pick<>` of exactly the fields it prints, so a URL, header, body, variable, token or
secret is not reachable from inside it, and a run's URL is cut to its path with `lib/path-label.ts`
(`pathLabel`, shared with the tab titles) plus a cut at any `?` or `#`. The module is pure - no React, store
or query import - so the caller resolves what a line names (a collection chain from
`collectionNamePath` in `modules/collections/tree-utils.ts`, a collection run's collection name) and passes
it in. The grammar and an example of every kind are in
[MCP: Naming what the user means](../../engine/mcp.md#naming-what-the-user-means);
`agent-reference.docs.test.ts` fails when a line on that page stops matching the formatter's output.

The surfaces that put a line on the clipboard are the "Copy for agent" row actions (#2047): request, collection,
environment, history, inbox, mock-issuer and mock-server rows, the tab menu and the palette's
`copy-for-agent` command, each through `useCopy()` with the name "Reference" (toast "Reference copied"). A collection's line takes the chain *above* it and a request's the chain of its own
collection, so neither names a folder twice. The same line is on the surfaces that have no row menu:
a trash entry, an example row, a capture's detail header (the shared `CopyForAgentButton`), a variable row and a
run sample's header carry an icon button (`useCopy({ feedback: "icon" })` with `IconSwap`, so the glyph swaps to a
check and no toast follows), and the inbox and mock-server tab headers a text "Copy for agent" button (toast
"Reference copied"). The URL copy buttons beside it are icon buttons too (#2315).
A pipeline element row (`ElementList`) has a "Copy for agent" item in its `⋯` menu, after Duplicate, built from
the element's id, kind and name alone; the host names the owner through `referenceOwner` (the request builder's
Elements tab for a saved request, the collection's Elements tab for the collection) and the item is absent without
one. A variable row takes its scope from `VariableTableEditor`'s `config` and is absent for a secret row, an
unsaved row and a scope that is not loaded; the line is built from the name alone, so the value never reaches it.
A run sample's button (the shared `CopyForAgentButton`) is absent without the run id (`report.metadata.runId`) or the sample's result row id.
The next three are icon buttons too, drawn by the shared `components/shared/CopyForAgentButton.tsx`
(`reference` and `label` in, the glyph swap and the `size-control-sm` hit area inside): the GraphQL Query pane's
operation picker (`graphqlOperationReference`, named by the saved request - `BodyPanel` reads the saved row, as
`ExamplesPanel` does, so an unsaved rename never reaches the line - and passed to the lazy `GraphQLBody` as the
`operationReference` prop); each operation row of
the Spec tab's Sync report (`specOperationReference`, in the collection being synced, beside the row's label and
not inside it so a copy never ticks the row), and each budget (`thresholdReference`) - on the verdict card, of the
run (`runId`, from `report.metadata.runId`, absent without it), and in the load test dialog, of the saved request
(`referenceOwner`, absent in the collection runner, which has none). The dialog's fixed fields carry it
through `NumberField`'s `action` slot, keyed by the payload's own key (`latencyP99Ms`); a custom row carries it
once it has a metric name, keyed `custom.<name>.<stat>` as `budgets.ts` sends it, and holds an empty slot of the
same width before that so the columns do not shift. Run coverage's operation rows (`ContractCoverage`) carry none:
the run's report names the spec but not the collection that holds the binding, which is an ancestor of the
collection that ran when the binding is inherited.
