---
description: >-
  Shared form components of the Vayu desktop app: drawer section, field error, allowed origins and number fields, the external change callout and script snippets.
---

# Shared: Fields and Snippets

## Drawer Section (`components/shared/DrawerSection.tsx`)

A group of rows inside a drawer view, and its header: muted small type, an optional scope glyph, an
optional count, an optional collapse chevron and a trailing actions slot. `DrawerPanel` gave the four
views one frame; the groups *inside* a view had none - Services drew muted labels with a plus,
Variables a chevron, an icon, a filled `Badge` count and a plus, and the collection rows wrote the
same fact as inline `(2)` text one click away from that badge (issue #1688).

**One count idiom, and the badge loses**: `DrawerSectionCount` is the muted inline count in
parentheses, exported so a *row* inside a section writes it exactly as its header does - which is how
`CollectionItem` stays in step without gaining a section header (its `DrawerPanel` band already says
"Collections"; a section of the same name inside it would be the double heading this issue removed
from Settings). A string count (`"-"`) is for a number the app does not have yet: a literal `0`
beside "Couldn't load collections" asserts something untrue.

**What a folder row counts** (issue #2251): a root shows every request in its whole subtree
(`countSubtreeRequests`, folders not counted), so a 60-request import into four folders reads
`(60)` as the import preview did; a nested folder shows its direct children, requests and child
folders. `aria-setsize` stays direct children at every depth.

**The header's semantics stay at the call site.** Variables' headers are `role="treeitem"` rows in a
roving-tabindex tree, and the "+" beside one is deliberately outside that row - the tree has no
create key, so the button is the drawer's own tab stop. `rowProps` and `activatorProps` are spread
through, so this component owns the shape and never has to know about the tree.

## Field Error (`components/shared/FieldError.tsx`)

The message under a control that will not take what you typed, and the bottom of the app's three
error levels: **field-level** is `FieldError`, **block-level** is [`Callout`](../../design-system/index.md),
**pane-level** is `ErrorState`. Before issue #1688 the middle of that range was hand-written
`text-destructive-text` paragraphs at three sizes - the import dialog alone carried `text-sm`,
`text-xs` and `text-[11px]` - some with a leading glyph, some announced and most not.

One size (`text-xs`: the sizes were the order the code was written in, not a hierarchy),
`role="alert"` so a message that appears after a keystroke announces itself, an `id` for the
control's `aria-describedby`, an optional leading `icon` for a message that has to be found among
other lines of the same size, and `as="span"` for a parent whose content model is phrasing only (a
`<label>`, another `<span>`) where a `<p>` would be silently reparented out of its row. It renders
nothing for an empty message, so a call site is `<FieldError>{error}</FieldError>` rather than
`{error && …}` - the same swallowing `TabCount` does with a zero. `error-presentation.test.ts`
fails on red prose outside the three primitives; a site where the token is on data rather than on a
message (a failure count, the Dock's "Not saved") is named in that guard's exemption list with what
the red text is instead.

## Allowed Origins Field (`components/shared/AllowedOriginsField.tsx`)

The "Allowed origins" box on the mock server's and the inbox's start forms (issue #2367): a
`Textarea`, one `http(s)://host[:port]` per line, with the helper text "Leave empty to allow any
origin" and a `FieldError` beneath. Shared because both forms ask the same question in the same
words. The parent owns the text and runs `parseAllowedOrigins` (`lib/allowed-origins.ts`), because
it also needs the result to decide whether Start is enabled and what to send; the field only
displays. The parser mirrors the engine's rules (shape, 32 entries, 512 bytes) and sends the
canonical spelling, repeats listed once; the engine stays the authority.

## Number Field (`components/shared/NumberField.tsx`)

A labelled number input with its unit inside the field (`ms`, `%`, `req/s`), an optional hint line,
and an `(optional)` marker on the label - the shape every pass/fail budget field needs. Moved here
from `LoadTestConfigDialog/index.tsx` (issue #1564) once `RunCollectionDialog`'s own Pass/fail
budgets disclosure needed it too: a second copy would not have received this one's fixes. Both
callers pass their own `id` so the two dialogs' budget fields never collide if ever mounted together. An
optional `action` slot draws a control beside the input; `LoadTestConfigDialog` puts each budget's "Copy for
agent" button there (#2047), and the collection runner leaves it empty.

A numeric `value` makes it a number field (#3079): the typed text is held in the field while it is focused and
`onChange` hears only non-empty text, so clearing it to type a new value never writes `Number("")` (0) back and
gives `050`; on blur an empty field returns to `value`. `min` and `max` are advisory only: the browser does not enforce them on a typed value (there is no `<form>`), so a caller that must refuse an out-of-range value checks it itself (`rangeError`, `utils/loadTestValidation.ts`). A string `value` (the budget fields, where "" means no
budget) is passed through untouched.

## Shared External Change Callout (`components/shared/ExternalChangeCallout.tsx`)

"Changed elsewhere: `<what>`", with a "Take theirs" action, for a field a dirty
draft is keeping against an external write it disagrees with. Started as
`CollectionDetail/shared.tsx`'s (issue #1437, `useEntityDraft`'s
`externalValue`) and moved here for issue #1436, when the request builder
needed the identical notice for the identical reason: a second copy would have
been the "written but never read" style drift CLAUDE.md warns about, just for
a component instead of a field. `CollectionDetail`'s `InfoTab`/`ElementsTab`/`AuthTab`
and the request builder's `ExternalChangeNotice` (above) are its callers.

## Shared Script Snippets (`components/shared/ScriptSnippets.tsx`)

The insertable templates under a script editor, listed for both script hosts -
the shared `ElementList`'s `script.*` bespoke form (`ScriptElementForm`,
`components/shared/ElementList/`) used by both the request builder's Elements
tab and the collection detail's (issue #1223).

**It replaced two hand-rolled copies of one idea.** The request panels carried a
14-line `<pre>` of `pm.*` calls plus nine paragraphs of rules, always on; the
collection tab carried a four-card grid of four different calls, behind a
component-state chevron. Neither could be inserted, so a user read a line and
retyped it, and the two lists had drifted from each other and from the runtime.

**The engine's completion table is the source, not a third list here.** Its
snippet entries (`kind` 28) now say which script kind they belong in and which
heading they are listed under (`context`, `group` - see
[`pm-api-compatibility`](../pm-api-compatibility.md#editor-autocomplete)), so this
component is a filter and a renderer over `GET /scripting/completions`: the same
templates Monaco offers as you type, made browsable for the author who does not
know what to type yet. `lib/script-snippets.ts` is that pure read, so the
selection rules are tested without a Monaco instance; a heading this build does
not know is listed under its own name rather than dropped, since the engine is
the one that decides what exists. The `context` prop is `pre`, `test` or
`both`: the first two list that context's templates and the shared ones, and
`both` lists only the shared ones, for a `script.setup` / `script.teardown`
editor, which has no request or response for a `pm.request` or `pm.response`
template to read (#3457). A context with no template at all (the engine
shipped none) shows one line saying so rather than an empty filter field.

**Insertion goes through Monaco's snippet controller** (`lib/editor-snippet.ts`),
not a text splice: the templates carry `${1:...}` placeholders, and only the
controller turns those into the tab stops the same template produces when it is
accepted from the completion popup. The host owns the editor instance (captured
through `CodeEditor`'s `onMount`) and passes `onInsert`, so this list never
learns which editor it sits under.

**Collapsed by default, remembered by the host** (`scriptSnippetsCollapsed`,
persisted). The collapsed flag is a controlled prop (`collapsed`,
`onCollapsedChange`), not this component's own store read (issue #1605): the
Elements tab can mount a `script.pre` and a `script.post` row on one screen,
and a single store subscription here would toggle both from one click.
`ScriptElementForm` seeds its own per-row `useState` from the store's
persisted default and writes a toggle back to it, so the *next* row a user
opens still starts where they left one - the reason the GraphQL Variables
pane's collapse lives in that store too, just no longer read directly here.
The whole header is the control, per the composite-row hit-area rule, and the
body is rendered only while it is open. `cmdk` (`Command`) owns the arrow
keys, the highlight, Enter to insert and the filter field, rather than a
third copy of that keyboard handling.
