---
description: >-
  The shared ElementList of the Vayu desktop app: the one list that edits extractors, assertions, timers and scripts.
---

# Shared ElementList (`components/shared/ElementList/`)

The primitive both Elements tabs bind to (issue #1512): an ordered list of a
request's or collection's own elements - extractors, assertions, timers,
controllers and scripts - each a **collapsible card** (issue #1608): a family
icon (one per catalogue category, `element-categories.ts`'s `categoryIcon`),
the element's name or its kind's label, a one-line **summary** of its config
while collapsed (`summarize-element.ts` - `in [200, 201]`, `wait 500 ms`,
`$.token → token (env)`; a kind this module has no template for falls back to
the kind's own description, and one that is genuinely unconfigured to its
first two properties as `key: value`), an enable switch, and a `⋯` menu
(`RowActionsMenu`) for Rename, Move up/down, Duplicate, Copy for agent (when the
host passes `referenceOwner`, #2047) and Delete - the two
Move items carrying "Already first" / "Already last" at the row's ends rather
than being silently off (#1690). Click on
the header toggles the card; a newly added or duplicated element opens
expanded, everything else starts collapsed. Which cards are open is kept per
request or collection id in `tab-selection-store`, so it survives the builder
unmounting and a switch between two open tabs: both hosts bind the list's
optional `openIds` / `onOpenChange` props through `useOpenElementRows`
(`ElementList/useOpenElementRows.ts`), which subscribes by selector. The list
calls `onOpenChange(id, true)` for a row it adds or duplicates and
`onOpenChange(id, false)` for one it removes, so the set never holds an id the
list no longer has. A host with no id (the stored-run copy, an unsaved
request) passes neither prop and keeps component-local state. Alt+Up/Alt+Down on the header's
own two toggle buttons moves the row, mirroring the menu's Move items.
**Rename's autofocus is timed off `RowActionsMenu`'s `onCloseAutoFocus`**, not
a guessed delay: selecting Rename only flags the row's own pending-rename ref,
and the actual state flip - drafting the name, showing the input - runs from
that callback, which Radix itself calls once the closing menu's `FocusScope`
teardown (and the `aria-hidden` it places on the rest of the page while open)
has actually finished. A raw `setTimeout` landed the autofocus before that
cleanup reliably completed, focusing an element still marked `aria-hidden` for
a moment - caught live, not by the jsdom suite, which has no real layout or
`aria-hidden` enforcement to catch it on. The title span itself is capped
(`max-w-[55%]`) alongside `truncate`: a user-typed name has no length limit,
and `truncate` alone never engages without a `max-width` to truncate against -
an uncapped one rendered at its full content width and pushed the switch and
the `⋯` menu out of the row. **The expanded card and `GenericElementForm`'s
own rows run at the app's tightest density** - `space-y-2` and `p-2`/`py-2`
throughout, `size="sm"` inputs, `text-xs` labels -
because this is where a user reads several fields at once, closer to a form
than a settings page read one row at a time. The collapsed header (`h-8`,
matching every other drawer row) is untouched; only what opens beneath it got
denser.
**A missing required field names itself, in place of the summary** (issue
#1635): `missingRequiredKeys` (`lib/elements.ts`) reads the presence-only
top-level check `addElement`'s fresh `config: {}` can trigger, and the row shows "Needs
`<title>`" with a warning dot instead of `summarizeElement`'s preview -
whether the card is open or collapsed, since a list of collapsed cards is
exactly where a user needs to spot which one is blocking the save without
expanding each in turn. `RequestBuilderProvider`'s `handleSave` and
`ElementsTab`'s `persist` hold the list back for the same reason
`defaultConfigFor` exists above - a request's whole `elements` array 400s on
one incomplete member - and throw `SaveBlockedError` instead of sending a
payload already known to fail; `useSaveManager` reads that type to stay
"pending" rather than backing off a retry against a payload that will not
have changed by the next attempt. Only the list is held back (#3048): the
builder still sends every other field the user touched (a URL, a header) and
throws once that save lands, keeping `elements` touched and its baseline at
the last saved list, so a retry while the element is still invalid sends
nothing and the fixed list goes out on its own.

**A value the schema refuses is held back by the same gate** (#3048):
`validateElementConfig` (`lib/elements.ts`) walks the kind's `configSchema` and
returns one short message per failing field, keyed by dot path (`range.max`),
for every field at once where the engine names only the first. It judges the
keywords the catalogue uses - `minLength`, `maxLength`, `minimum`,
`exclusiveMinimum`, `maximum`, `pattern` and a nested `required` - and not `type`
or `enum`, which the form's controls write. A missing top-level `required` key
stays `missingRequiredKeys`' chip, so no field is reported twice; a nested one
(`assert.status`'s `range` without `max`) has no chip, so the validator names
it. A `pattern` that fails shows the hint in `PATTERN_HINTS` where there is one
(`control.if`'s "Use {{var}} == value") and "Doesn't match the expected format"
otherwise; a pattern JavaScript cannot compile is no constraint.
A **malformed JSONPath** is the one rule no keyword carries (the schema says only
`type: string`): `JSON_PATH_FIELDS` lists every config string the engine reads
as one - `assert.jsonpath` and `extract.json`'s `path`, `assert.jsonschema`'s
`path` (only while its `source` is `jsonpath`), `metric.record`'s
`source.jsonpath` and `source.eventJsonpath`, and its `source.condition.jsonpath` only while
that condition's `field` is `jsonpath` - and `isSupportedJsonPath` refuses what
`parse_json_path` (`engine/src/core/elements/json_path.cpp`) refuses: no leading
`$`, an empty `.name`, a filter, an unterminated or empty `['name']`, a `[n]`
that is not a whole integer. The message is "Start with $, then use .name,
['name'], [n] or [*]". Like `OPERAND_RULES` this **restates the C++**: the
conformance test holds each entry to a property the live catalogue declares,
but a change to `parse_json_path` or to where `json_path_problem` is called
needs a hand edit in `lib/elements.ts`. Only a string is judged; an absent or
mistyped value is the schema's.
`hasIncompleteElement` is also true when the validator finds anything, so the
save gate and the messages agree. `element-kinds.conformance.test.tsx` fails
when the catalogue gains a keyword the validator does not judge.

**One judgement behind the chip, the gate and Send** (#3066): `elementNeeds`
(`lib/elements.ts`) is `missingRequiredKeys`, `missingOperand` and
`validateElementConfig` for one element, answering `{ missing, invalid }` or
`null`. `ElementRow` draws its chip and field errors from it,
`hasIncompleteElement` is `some(elementNeeds)`, and `sendElementsParts` leaves
out of a Send exactly the draft elements it answers for - so what the editor
flags is what does not run, and the three cannot drift.

**The message is shown on the field it is about** (#3048). `ElementRow` takes
the `invalid` half of `elementNeeds` (`validateElementConfig`'s map) and hands it to the kind's form as
`errors`: `GenericElementForm` reads each row's message by name and gives a
nested object its slice (`errorsWithin`, so `range.max` reaches `Maximum` and
not `Minimum`), and `ModeElementForm` slices again for the `source` level and a
nested mode before handing its generic parts theirs. A row shows its message the
way `NumberSettingRow` always has: `aria-invalid` on the control, the
`border-destructive` edge and a `FieldError` the control's `aria-describedby`
names, ahead of the hint's id. Number, text, dropdown (`SelectSettingRow`'s
`error` prop) and untyped JSON fields all do; a boolean row shows none, so
`script.pre` / `script.post`, which pass the prop to their advanced Run inline
switch, show no message there today, and `script.setup` / `script.teardown`
render nothing there and ignore it. Only a value that is present and refused
shows a message: a fresh element's absent keys stay the "Needs ..." chip's, so
the same field is never told twice. The row's mark covers both halves of
`elementNeeds` (#3066): a collapsed element with a refused value and no missing
key reads `<field>: <message>` where its summary would be, the same wording
(`describeNeeds`) the response's `Not run - ...` line uses. The engine's refusal of a whole element
(above) is a row-level line under the header and ends when the element is
edited, so it does not repeat a field's own message.

**A kind that needs one of several operands is held back the same way**
(#3043, #3055): `assert.status` needs a non-empty `in` or a `range`,
`assert.jsonpath` one of `expected`, `regex` or `exists` (the engine also
refuses `exists` beside either of the others, #3049), `control.throughput` a
`percent` or an `everyN` (the engine refuses both), `timer.think` an `ms`, a
`gaussian` or both `minMs` and `maxMs`, and `assert.contains` a non-empty `text`
unless its `mode` is `equals` or `matches` (a cleared field leaves `text: ""`,
which the engine refuses in the default `contains` mode), and `assert.jsonschema`
a `schema` that is an object or a boolean (typed text that is not JSON is stored
as a string, which the engine refuses; an absent one is `missingRequiredKeys`')
and, once its `source` is `jsonpath`, a `path`: its rule's `needs` is a function
of the config, so the chip names the unmet half (#3806), and `assert.snapshot` a
`baseline` that is an array (typed text that is not JSON is stored as a string; an
empty list is a baseline, a server that answers none, #3807). The mode picker writes
one key at a time, so the app never sends a mix the engine refuses; if one
arrives anyway it is named on the row by the engine's own 400 (below). The
engine refuses an element with none, and JSON Schema cannot say "one of", so
`OPERAND_RULES` (`lib/elements.ts`) restates the rules and `missingOperand`
feeds the same "Needs ..." chip ("Needs accepted codes or a range") and the
same `hasIncompleteElement` gate; `element-kinds.conformance.test.tsx` holds
every key in the table to a property the engine's catalogue declares. The rule
for a kind whose `text` is already `required` sets `judgesValue`, since
`missingRequiredKeys` owns its absence.

**An element the engine still refuses is named on its row** (#3043): the engine's
`'<Kind label>' (item N): <problem>` 400 (`parseElementRefusal`) is matched
back to the element at position N of the array that was sent, and
`useElementRefusals` hands `ElementList` an `errors` map by element id, drawn
as a `FieldError` under that row's header, open or collapsed. The refusal is
kept against the element object, so it ends the moment that element is edited.
`RequestBuilderProvider.handleSave` (as `elementErrors` on the context) and
`ElementsTab.persist` record it and rethrow, so the save's toast, Dock status
and callout are unchanged; a message that does not read this way (an older
engine) leaves only those. The regular-expression cases land here, since RE2
exists only in the engine.

**Delete asks nothing for a blank element** (every configured value empty or
absent) and confirms through `DeleteConfirmDialog` for one with real
configuration. A primitive under `components/shared/` takes no feature-module
context, so both hosts pass their own `elements` array, `onChange` setter and
the catalogue (`useElementKindsQuery`) as props rather than the component
reading either host's context - the same rule `request-builder/types.ts`
states for why `KeyValueEditor` moved out of the request-builder module.

**The default form is generated from the kind's JSON Schema**
(`GenericElementForm.tsx`), the way `SettingsMain.tsx` renders a config entry
by type: string, integer, number, boolean, enum and string-array properties
map to the same row primitives - `NumberSettingRow` / `SelectSettingRow` /
`ToggleRow` - `SettingsPanel.tsx` already uses, plus one level of `object`
nesting for a kind whose config groups two fields (`assert.status.range`'s
`{min, max}`). **Labels come from the schema's own `title` and `description`**
(issue #1607), not the raw property key - `control.throughput`'s `everyN`
reads "Every nth", not `everyN`. A `required` property renders before an
optional one; a property carrying `x-vayu-group: "advanced"` renders instead
under a disclosure, closed on mount unless the element already has a value
for one; `x-vayu-unit` (`"ms"` / `"%"` / `"B"`) becomes the numeric field's
input suffix. A kind the app has never seen is still editable the day the
engine ships it, which is the whole point of the catalogue being
schema-carrying rather than a label list - `extract.json`'s path field is
deliberately generic-form only, proving the point rather than special-casing
it. **An absent key shows the property's catalogue `default`** (#3045), the
value the engine runs, so `assert.size`'s `op` reads `lte` and `timer.pacing`'s
`perUser` toggle starts on; the summary reads the same field for
`extract.*`'s `scope` and pacing's `perUser`. It is display only: nothing is
written into the config until the user changes the field.

**A property with no `type` takes a JSON field, not a text one** (#3046).
`assert.jsonpath`'s `expected` and a `metric.record` condition's `value` can
hold any JSON value, and the engine compares them strictly, so the string "7"
never equals a number. `JsonValueField` reads typed text with `JSON.parse`
(`7`, `true`, `null`, `"a"`, `{...}`), stores the raw text as a string when it
is not JSON, and a hint under the field says which it became ("Stored as
number"). A stored string whose text would itself parse as JSON is shown
quoted (`"7"`), so it round-trips instead of turning into a number on the next
edit. The text lives in a draft, as the comma-separated list's does, so
`{"a` or `-` is not rewritten under the cursor, and loading a value writes
nothing. A property that declares `string` stays a plain text field.

**A field the engine resolves `{{tokens}}` in is a variable-aware input**
(#3779). `assert.contains`'s `text` in `contains` / `equals` mode and
`assert.jsonpath`'s `expected` are substituted when the assertion runs, so one
assertion can judge each data row against its own `{{data.column}}`; the form
paints those tokens, completes `{{`, and opens the edit popover through
[`VariableInput`](shared-variable-input.md#shared-variable-input-componentssharedvariableinput) rather
than a plain `Input`. Which properties those are is `variable-fields.ts`'s
table (`resolvesVariables`), the one place that says so, held against the
catalogue by `element-kinds.conformance.test.tsx`: `GenericElementForm` takes the
element's `kind` and the host's `variables` and consults it, and `ElementList`
takes `variables` from the host (`ElementsPanel` passes `useVariableSupport()`,
`ElementsTab` its collection's scope). `text` stays a plain field in `matches`
mode, where it is a pattern the engine never resolves, and `regex` always does;
a sub-object's form is handed no `kind`, since the table names a kind's top-level
properties only. `JsonValueField` still reads typed text as JSON, so
`{{data.n}}` is stored as that string, `7` as a number and
`{"id":"{{data.id}}"}` as an object whose string is resolved at run time. With no
`variables` (a host without a scope) both are the plain fields they were.
`VariableInput` forwards `aria-invalid` and `aria-describedby` to its `<input>`
for these fields' `FieldError`s.

**An `object` that declares no `properties` takes a key/value editor, not a
text box** (#3047). `control.switch`'s `cases` maps a variable's value to a
folder member's name, and the text box it used to fall through to saved a
string, which the engine refuses with a 400. `StringMapField` is a row per
entry (a key input, a value input, a remove button) plus an "Add entry"
button; the stored value is a plain object of string to string, and an
existing object renders its rows. The rows live in a draft, as the list's text
does: only rows with a non-empty key are written (so a blank or half-typed row
saves nothing), and when two rows share a key the later one wins. Rows have
ids of their own, so renaming a key does not move the row. The editor is never
paired onto a `grid-cols-2` line. It is deliberately not `KeyValueEditor`,
which carries the request builder's file, variable and enable-toggle features.

**Two short fields standing next to each other share a line** (`grid-cols-2`,
the pairing `AuthFields` and `OAuth2Form` already use). `assert.status`'s
`range` is one idea - "200 to 299" - and saying it as a label, a hint sentence
and an input stacked twice over spent most of an expanded card on two
integers. Only a number or an enum pairs: a JSONPath, a variable name or a
regular expression has no length bound, and a boolean is already horizontal
(`ToggleRow` is label-left/switch-right), so halving its width only crowds its
description. And only **exactly two** adjacent - a run of three is a list, not
a pair (`timer.think`'s `ms` / `minMs` / `maxMs` is a fixed wait beside the two
bounds of a random one, and pairing by position would claim a relationship the
schema never declared). Which two of three belong together is knowledge only
the kind has, and this form knows no kinds: a kind that wants the grouping
declares it as a nested `object`, the way `assert.status` already does, and is
paired here for free. The halves are the settings rows' opt-in `compact`
variant, so each one fills its column instead of stopping at the settings
screen's `max-w-[12rem]` with the rest of the line empty.

**A bespoke override is the exception, in one map** (`elementForms.ts`), never
inline in `ElementList`. There are four: `ScriptElementForm`, below,
`ModeElementForm` for the five mutually-exclusive-strategy kinds, after it,
`JsonSchemaElementForm` for `assert.jsonschema` (#3806) and `SnapshotElementForm`
for `assert.snapshot` (#3807).
Phase 0 ships a bespoke form for every `script.*`
kind - `script.pre` / `script.post` and, since issue #1499, `script.setup` /
`script.teardown` - which render `ScriptElementForm`'s Monaco editor and
insertable snippets instead of the generic form's plain text field, because
"the same editor" is what the Elements tab has to keep for a script. The kind
picks the editor's accessible name (Pre-request, Post-request, Setup or
Teardown script, which the resize handle's name extends) and the snippets it
offers: setup and teardown run outside any request, so they get only the
engine's `both` templates, never a `pm.response` one (#3457). Its lead
sentence is the kind's own catalogue `description` (issue #1608, absorbed
there by #1607) rather than a hard-coded pair of strings, so the text is
authored once and doubles as the card's collapsed-summary fallback. **The
kind's advanced properties render under the editor** (#3457): `script.pre` /
`script.post` declare `config.inline` ("Run inline", `x-vayu-group: advanced`)
and nothing else in the app set it, so `ScriptElementForm` takes the `schema`
and `errors` `ElementList` hands every bespoke form, slices the advanced
properties out of the schema (`subsetSchema`, `schema-subset.ts`, shared with
`ModeElementForm`) and renders them through `GenericElementForm` - the switch
is the generic form's own `ToggleRow` inside its Advanced disclosure, closed
until the element sets one, and turning it off stores `inline: false` rather
than removing the key, as that form does for every boolean. `script.setup` /
`script.teardown` have no `inline` (the engine refuses it: a run-boundary kind
has no inline-or-deferred choice), so their subset is empty and the form
renders nothing there, not an empty disclosure. It
deliberately carries none of the old `ScriptPanel`'s variable-reference chips
or inherited/legacy notices - those read `useRequestBuilderContext`, which
this primitive cannot depend on - so inheritance is shown once for the whole
list by `InheritedElementsNotice` instead of once per script row.

**The editor box has a definite pixel height, resizable by a handle below it**
(issue #1605). `ElementRow` is an auto-height card, not a bounded ancestor a
percentage or a `ResizablePanelGroup` could divide, so `CodeEditor`'s default
`height="100%"` used to resolve against nothing and Monaco laid out at zero
height with the typed text hidden. `ScriptElementForm` instead sets the box's
height directly from `layout-store`'s `scriptEditorHeights`, keyed by the
owning element's own `id` (`ElementRow` passes it) - a request or collection
can show a `script.pre` and a `script.post` card at once, and a single shared
value used to mean dragging either one's handle resized both (issue #1643
part 2). A row with no entry of its own starts from the last height set on
*any* row, `scriptEditorHeightDefault`, read once at mount rather than
subscribed to - so a still-mounted row with no entry is never retroactively
resized by a later drag elsewhere. Duplicate (issue #1608) copies the source
row's own entry onto the new id, so a duplicated script starts at its
source's height rather than the default. A handle below the box drags it
between `SCRIPT_EDITOR_MIN_HEIGHT` and `SCRIPT_EDITOR_MAX_HEIGHT`
(`constants/layout.ts`) through `useResizeGesture` (`lib/resize-gesture.ts`,
issue #1738), the rAF-coalesced-write, one-commit-on-release mechanism
`PanelResizeHandle` also uses for the drawer and context bar widths and the bottom panel's height (issue
#1715) - a shared hook rather than two independently-written copies, after
those copies had already drifted (this row's keyboard handling covered only
Arrow keys, and neither handled `pointercancel`). Arrow keys, Page keys,
Home/End and a reset (Enter/Space, to `DEFAULT_SCRIPT_EDITOR_HEIGHT`) all
commit immediately on a discrete press; a held key's repeats are throttled to
one commit per 200 ms (`KEY_COMMIT_INTERVAL_MS`, flushed on keyup and blur;
OS key repeat is slower than a frame, so per-frame coalescing would not help),
so holding a key does not flood `localStorage` with one write per repeat. A `pointercancel`
mid-drag (a touch interruption, an OS overlay) reverts the box to the height
the drag started from and writes nothing.

**Five kinds pick one strategy instead of showing every one at once**
(`ModeElementForm.tsx`, with the table in `element-modes.ts`). `assert.status`
accepts an `in` list **or** a `range`; `timer.think` waits `ms` **or**
`minMs`/`maxMs` **or** a `gaussian`; `assert.jsonpath` checks `exists` **or**
`expected` **or** `regex` (the **Exists** mode writes `exists: true` and has no toggle -
`negate` turns it into "must be absent", while a stored `exists: false` summarizes as
"<path> does not exist", #3049); `control.throughput` limits by `everyN` **or**
`percent`; `metric.record`'s `source` reads exactly one of its seven keys. The
engine resolves each by an if/else-if chain or a fixed-priority loop and never
combines two - but JSON Schema declares them as independent optional siblings,
so the generic form rendered every alternative's fields at once, with nothing
saying which one would actually run. That is not only clutter: an element that
once had a `range` and was then given an `in` kept the `range` invisibly, and
the engine's own priority could still prefer the hidden one over the fields on
screen. `metric.record`'s schema comment says why the fix cannot be a
schema-level `oneOf` (valijson reports "matched N schemas" without naming one),
so it lives entirely here. **The mode on screen is derived from `config`, by
the engine's own priority order** - transcribed into `detectionOrder`, one per
kind, each naming the C++ function it came from - so the card cannot claim one
strategy while the engine runs another; a blank element starts on the kind's
stated default (`assert.status` on `in`, `timer.think` on `ms`, which is the
engine's *fallback* rather than its first check, hence the two orders being
separate). **Switching modes clears the other strategies' keys**, since a
leftover is both unreachable in the UI and, with `additionalProperties: false`
on all five schemas, a save failure. The chosen mode's own value is kept, not
reset - switching *to* it is what makes that data visible and editable. The
picker is the `ToggleGroup` segmented control up to three modes and a compact
`SelectSettingRow` past that (`metric.record`'s seven sources), the split
`SettingControls.tsx` already draws between a few options a user browses and a
set that reads as a list. Everything below the picker is still
`GenericElementForm`, over a subset of the same schema: titles, hints, units,
the advanced disclosure and the two-fields-per-line pairing arrive unchanged,
so a mode's fields are literally the same rows as every other card's. A mode
whose key is a boolean *marker* (`exists`, `latency`, `status`, `size`) renders
no field at all - the engine reads the key's presence and ignores its value, so
a toggle would offer an "off" that turns nothing off; choosing the mode writes
`true`. Only the mode *labels* are app-side copy, because a strategy is a
grouping the schema does not name (`minMs` + `maxMs` are one mode with two
titles); every field label still comes from the catalogue.

**`assert.jsonschema` is not a mode kind** (`JsonSchemaElementForm.tsx`, #3806):
its `source` is a *value* (`body` or `jsonpath`), not a key that is present or
absent, which `ELEMENT_MODES` cannot express. The engine reads `path` only for
`source: jsonpath` and refuses one beside any other source, so the form draws the
`path` field only for a JSONPath source and a switch back to the body removes
`path` from `config`. Its `schema` is a document, so it takes `JsonValueField`
in its `multiline` form - a resizable monospace textarea showing a stored object
indented, parsing typed text exactly as the one-line field does - instead of a
one-line input that would show a schema as a scrolling strip. The collapsed row
reads `body matches schema` or `<path> matches schema` (`summarize-element.ts`),
never the schema itself, and its icon is `FileCheck`.

**`assert.snapshot` is a bespoke form for its array** (`SnapshotElementForm.tsx`,
#3807): `baseline` is an array of objects, which the generic form's array field
(scalars split on commas) cannot hold, so the form is the catalogue's `method`
select over a subset of the schema plus the same multi-line `JsonValueField`
`assert.jsonschema` uses. The collapsed row reads `<method> - <n> items`
(`summarize-element.ts`, `tools/list` while the element names no method), never the
recorded items, and its icon is `Camera`. **Recording the baseline is an action of
the request builder, not of the list**: the Elements tab renders
`panels/SnapshotBaselineAction.tsx` through `renderAboveForm`, a **Use the current
reply as the baseline** button that reads the builder's current response, takes
the list at `result.tools` / `resources` / `prompts` for the element's `method`
(`utils/list-snapshot-baseline.ts`: the reply is one JSON-RPC object or an event
stream whose last `message` response is the answer; the engine matches the
request's `id` and the app does not know it, so a stream whose responses carry
more than one `id` is refused) and writes it into
`config.baseline` through `updateField("elements", ...)`, the path a typed edit
takes, so the summary and the field follow. It is disabled, with a `DisabledHint`
saying why, before anything was sent and when the reply holds no such list (an
error response, another method's answer, a body that is not JSON). The collection's
Elements tab has no response and so no button. A failed comparison arrives in
the response's Elements section as the engine's one line, shown verbatim like any
`assert.*` message (`ElementOutcomes`).

**A host can start a kind from more than the blank config** (`startingConfigs`
on `ElementList`, #3806): the request builder's Elements tab passes
`startingElementConfigs(request)`
(`request-builder/utils/starting-element-configs.ts`), which for an `mcp` body
whose stored tool has an `outputSchema` answers `assert.jsonschema` with
`{ source: "jsonpath", path: "$.result.structuredContent", schema: <outputSchema> }`.
The list merges it over the kind's own blank config **when the element is
added**; an element is stored data, so editing the tool afterwards does not reach
into it. The collection's Elements tab has no request, so passes none.

**The Add control is a searchable picker (issue #1604), not a plain dropdown.**
A `Popover` holds a `Command` (`ElementList/element-categories.ts`'s display
map), so a user can type "regex" instead of reading twenty rows for "Extract
with a regular expression" - each row shows the kind's description via
`TruncatedText`, not only on hover. Groups render in family order (Extract,
Assert, Timer, Controller, Script, Metric); a category the map does not know
still renders, last, under its own raw name, so a kind the engine adds needs
no change here. `control.transaction` displays under "Controller" although its
engine-side category stays `"transaction"` - that string is a load-bearing
lookup key for `TransactionHistograms` and the `includeTimers` fold, so the
picker folds it for display rather than the registration changing what it
means. `inherit.disable` is excluded from the picker entirely, since a user
never adds one by hand - it is written by the inheritance notice's Disable
toggle. The last five kinds added surface under a "Recently used" group,
persisted in `layout-store`'s `recentElementKinds`.

**A new request or collection sends no `elements` at all** (issue #1609):
creation used to seed an empty, enabled `script.pre`/`script.post` pair
(`lib/elements.ts`'s retired `defaultScriptElements`) so the two script tabs
this feature replaced still had a visible slot on a fresh entity. That made
`InheritedElementsNotice` claim "2 elements will run before your own" about a
collection whose two elements did nothing, and gave the engine an empty
script to compose, run and report as a real outcome. A blank `script.*`
element (`isBlankScriptElement`, `lib/elements.ts`) is now inert everywhere it
is read - `scriptTextFor`, the Elements tab's badge count, and
`InheritedElementsNotice`'s count and list - the app-side half of a rule the
engine pipeline enforces the same way (`docs/engine/elements.md`), so the
seeding lost its reason to exist. The notice also skips the collection-only
kinds (`script.setup`, `script.teardown`, #3457): a disabled or blank element
never runs, and these never run *before a request* at all. **A fresh entity's Elements tab shows a
sentence plus quick-add chips instead of a bare `emptyLabel` string**
(issue #1608): `ElementList` itself computes them from whichever kinds it
finds in the `kinds` prop it was already handed - Extract from JSON, Assert
status code, Pre-request script and Post-request script always (#2129), Setup script only when the
collection tab's own `kinds` (which, unlike the request tab's, includes the
`collectionOnly` kinds) offers `script.setup`. A click adds that kind,
expanded, the same as the picker.

**A newly added element seeds `config` from `defaultConfigFor`, not a bare
`{}`** - found live: the engine validates a request's whole `elements` array
on every save, and a script kind's schema requires the `script` key *present*
(`required: ["script"]`, checked engine-side by `valijson`, key presence only,
no `minLength`); `config: {}` alone omits it, so quick-adding "Pre-request
script" and then touching anything else on the request 400s the *entire* save
with "Missing required property 'script'", not only that element's own. A
script kind seeds `{ script: "" }` instead - a real, valid value (the engine
already treats a blank script as a no-op, `is_blank_script_element`), not a
placeholder. Every other kind still seeds `{}`: several of them have their own
required, non-blankable string fields (`extract.json`'s `variable`,
`control.transaction`'s `name`, both `minLength: 1`) that an empty string
would not satisfy either, and a kind-specific fake placeholder would be worse
than the failure it dodges - tracked as a follow-up rather than guessed at
here (issue #1635). A fresh `assert.status` or `assert.jsonpath` is the same
case without a `required` key, and the same answer: it seeds `{}` and the row
says what it needs (above) until the user gives it an operand.
