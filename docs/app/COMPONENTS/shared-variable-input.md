---
description: >-
  The shared variable input of the Vayu desktop app: how a field that accepts {{variables}} paints, resolves and edits them.
---

# Shared Variable Input (`components/shared/VariableInput/`)

`index`, `EditableVariable`, `RuntimeToken` - input with
`{{variable}}` highlighting + autocomplete. Takes the same optional `variables`
scope; without one it is a plain text field, since a token would paint a name
"not defined" and open an editor with nowhere to write. Its height is a `size`
prop, the same `"default" | "sm" | "xs"` as [`Input`](ui-primitives.md#input) and read from the
same `input-size.ts`, put on the wrapper that owns the box; a caller states a
size, never a height class (the key-value rows and the binary body's fields are
`size="sm"`). The URL bar's `UrlInput` is the exception the sweep names:
UrlInput is the one text field that is a band component, not a control: it
fills the min-h-band-md URL bar, so its h-full is correct.
The token overlay is `overflow-hidden` and follows the input's horizontal scroll
(`onScroll`, and a layout effect on the value and caret), so text typed past the
field's width stays visible (#3684). `aria-invalid` and `aria-describedby` are
forwarded to the `<input>` itself, not the wrapper, so a `FieldError` under the
field is tied to the control a screen reader lands on (the element forms use it
for `assert.contains`'s `text` and `assert.jsonpath`'s `expected`, #3779).

**A token has five states, decided in the order `resolveTemplate` decides
them** - reserved namespaces first, then a name the engine defers, then the
scopes, then the generator table.
The overlay paints that decision rather than making it; `classifyVariableToken`
makes it, for every surface (see below):

| Token | Painted by | Looks like |
|-------|-----------|------------|
| `{{data.email}}` - the reserved `data.*` namespace (issue #402) | `RuntimeToken`, or a decoration in an editor | muted or amber, depending on the declared contract - see below |
| `{{$vu}}`, `{{$iteration}}` - the reserved identity namespace (issues #994, #1101) | `RuntimeToken`, or a decoration in an editor | muted, "not generated here", no popover |
| `{{merchantId}}` - a stored variable, or a name nothing defines | `EditableVariable`, or a decoration in an editor | accent when it resolves, **red** when it does not; hover opens the popover inert (issue #1220 hover redesign), a click places a caret, and Enter/Space - or ⇧⌘D in an editor - opens it focused |
| `{{$guid}}` - a generator | `RuntimeToken`, or a decoration in an editor | muted, "generated per use", no popover |
| `{{token}}` - a name `POST /compose` lists in `deferredVariables` because a pre-request script runs before the send (#2741) | `EditableVariable`, or a decoration in an editor | **muted, dashed underline**, never the accent of a resolved token; the popover opens as for a stored variable. [Details](#token-named-in-deferredvariables) |

The two reserved rows sit above the scopes for the same reason and the generator
row below them for the opposite one: a scope that defines `$guid` wins and takes
the editable token, while a variable named `data.email` or `$vu` answers for
neither the column nor the identity, so it must not paint as though it had. The
identity names are matched exactly, so `{{$vus}}` is an ordinary unknown `$name`
and keeps the red paint that is how a typo is spotted (issue #186).

**A deferred token is the engine's call, not the classifier's.** The stored value
of a name a script sets is not what the send carries, so painting it as resolved
would say the opposite of the Code section and the Params tab's Sends line.
`RequestBuilderProvider` asks for the names once per builder
(`useDeferredVariables`, the Code section's `POST /compose` cache entry), only
while the request holds a `{{token}}` anywhere a painter draws one
(`requestHasTokens`), and hands them down as `VariableSupport.deferredVariables`;
`classifyVariableToken` takes them as an input and puts a listed name first among
the scope rungs, so it decides nothing about which requests are scripted. The
resolved views read the same names: the provider's `resolveField` leaves them
written, so the key/value rows' Σ peek and the Body tab's Resolved pane print
`{{token}}` with the sentence rather than the stored value (#2762). Until
the answer lands, and when it is empty, every token paints as it always did. A
script editor never paints a deferred token: the pre-request script is what sets
the name, and a post-request script reads it after that has run, so
`pm.variables.get` / `replaceIn` (the `"merged"` hint), an accessor that names
one scope (its `replaceIn` included), a row read and a bare `{{name}}` in script text all paint as they
always did. The collection tab's editors have no request to compose and never
defer.

**The same states now paint inside the Monaco body and GraphQL editors
too** (issue #1220), as decorations rather than DOM tokens - there is no
`<input>` behind that text to overlay. For a run-time token, hovering still
opens the app's own read-only card (`TokenHoverCard`) over the token's screen
rectangle - not Monaco's own hover widget, which is what answered until issue
#1320. For an editable token, hovering (after the same debounce) opens the
same shared `VariablePopover` instead, over that same rectangle, but inert:
nothing is focused, so resting the pointer never steals the caret from
wherever the reader is actually typing (issue #1220 hover redesign). A click on
an editable token now only places a caret in it - Monaco's own native
placement, once nothing intercepts the click - and `EDIT_VARIABLE_CHORD` opens
the popover focused, which is also the only role left for a keyboard user with
no hover state. The popover stays open through a short grace period if the
pointer moves from the token onto the popover's own content, and closing it
only calls `editor.focus()` back if it actually took focus at some point - a
hover the reader merely swept past must not steal focus from another field
when it closes. The decision of *what a token is* is shared:
`classifyVariableToken` (`lib/variable-token-kind.ts`)
lifts the same ladder this section describes out of the paint, so the editors
and the overlay answer one `{{name}}` identically - the overlay classifies
each `{{name}}` once per repaint, before any paint, and its five ordered
checks exist nowhere else (issue #1239). Read-only editors (response body,
raw request/response, the settings preview) paint no variables - a response
body's `{{x}}` is data someone was sent, not a token the app owns.

**Times are the editor layer's second matcher, gated apart from variables**
(issue #1786). `TIME_TOKEN_MATCHERS` (`lib/monaco-time-tokens.ts`) finds
every span `parseTimeValue` accepts - ISO 8601, the three HTTP date forms,
epoch seconds and milliseconds - in `json`, `javascript` and `graphql` as a
string literal whose whole content is a time or a bare 10- or 13-digit
number, and in `plaintext`, `yaml`, `xml`, `html` and `http` (the Raw tab, so
a `Date:` header and a `Set-Cookie`'s `Expires=` are marked) as a time-shaped
run anywhere, quoted or not. The range is the time itself, never its quotes; near
misses (`2026.10.05`, `20261005`, sixteen digits) find nothing. A time gets a
faint dotted underline (`vayu-time-token`) and, on hover, the same rows
`TimeValue` shows (`TimeHoverCard`, from `describeInstant`) in the tooltip
shell the variable card uses (`EditorTokenTooltip`). It has no popover, no
click and no chord: there is nothing to edit. Unlike a variable it needs
neither an editable editor nor a provider, so it runs in every `CodeEditor`
whose language has a time matcher, the read-only response viewers included.
`CodeEditor` draws the card itself (`TimeTokenCard`, from the hook's
`timeHover`), because most of those editors have no provider above them.

**Outside Monaco, a time is `TimeValue`** (issue #1786,
`components/shared/TimeValue/`). It takes an instant (`Date`, epoch
milliseconds) or the raw text an API sent, and a `style`: `datetime`, `date`,
`time`, `time-ms` (a live row that needs milliseconds), `relative`, or `raw` to
keep a string as it arrived. It renders a `<time>` whose tooltip is
`TimeHoverCard`: one `dt`/`dd` row per `describeInstant` row (the zone the OS
resolves, UTC, how long ago, and the original text when it differs), plus any
`extraRows` the surface adds, such as the run a restored response came from.
The card builds its rows when it opens, so a virtualised list pays for the
text only. A value that is not a time renders as plain text with no card, so a
surface can hand it whatever it holds. A string that cannot hold an element
(an `aria-label`, a native `title`, a palette subtitle) uses `formatInstant`
from `lib/time-value.ts` with the same style names; `formatDayHeading` writes
the history sidebar's day headings. `TimeTooltip` is the card on a trigger the
surface draws itself: the history row hangs it off its stretched activator,
with the status as an `extraRow`. API data in a table is
decided by `parseTimeValue` alone, never `new Date()`: `HeadersViewer` wraps
each time run of a header value (`proseTimeRuns`, the Raw tab's own reading)
in a `TimeValue` and leaves the rest of the text as received, and an editable
value - `KeyValueRow`'s headers and params, the variables table's value cell -
gets a `TimeMarker`, a clock button carrying the card, because an `<input>`
cannot hold an element and a tooltip on the field would open on every focus.
`KeyValueRow` puts it in the resolved peek's column (the peek wins on a row
with a variable); `VariableRow` puts it inside the field and never on a
secret. **`time-surfaces.test.ts` is the guard**:
it reads every non-test source file under `app/src`, asserts the scan is
non-empty, and fails on `toLocaleDateString`, `toLocaleTimeString`,
`toLocaleString` on a Date, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat` or
an import of the retired `lib/format-time` anywhere but `lib/time-value.ts` and
`components/shared/TimeValue/`, and on a `CodeEditor` that gains a prop to opt
out of the time matcher. `Number#toLocaleString` for counts stays. A test that
renders a `TimeValue` needs a `TooltipProvider`; `test/render-with-tooltips.tsx`
supplies one.

**Script (`javascript`) editors are decorated too, on three different
readings** (issue #1220 script support - `lib/script-variable-tokens.ts`,
gated per language by `VARIABLE_TOKEN_MATCHERS` in `monaco-variable-tokens.ts`,
a different gate from `BODY_LANGUAGES`, which stays the `{{` **completion**
list's own list and does not offer brace completion in a script):

- The string-literal argument of `pm.environment.get(...)`,
  `pm.globals.get(...)`, `pm.collectionVariables.get(...)`,
  `pm.variables.get(...)` and `pm.iterationData.get(...)` - a real read,
  painted and hoverable and (where the scope is writable) editable like a
  body token, but classified against only what that one accessor can see
  (`classifyScriptToken`, `lib/variable-token-kind.ts`): one scope's own
  answer for the first three, the whole merged ladder for `pm.variables` (the
  same answer a body token gets), and the bound data row alone for
  `pm.iterationData`. A setter (`pm.environment.set(...)`) is never matched -
  only `.get` is a read - and a name inside a `//` or `/* */` comment is
  excluded by the same scan that finds the accessor calls.
- Every `{{name}}` inside a `pm.variables.replaceIn(...)` call's template
  argument - the one place a script really is interpolated - gets the full
  body-language treatment: the merged ladder, no accessor to narrow it. The
  scoped `pm.environment` / `pm.globals` / `pm.collectionVariables`
  `.replaceIn(...)` calls (issue #3147) read that one scope first, as their
  `get` does, and a name that scope does not define falls through to what the
  engine resolves beside the scopes: a bare declared data column paints as a
  column (`pm.environment.get("email")` stays undefined, since a `get` never
  reads the row), `{{data.*}}` and the iteration identity paint as they do
  everywhere, and a `$` generator paints as generated unless that scope defines
  the same name. `pm.iterationData` has no `replaceIn`.
- A **bare** `{{name}}` anywhere else in a script is muted
  (`vayu-variable-token-runtime`) and read-only: hovering explains that the
  script never interpolates it (the same sentence the "Names mentioned" chip
  row already gives it, `TEMPLATE_IN_SCRIPT_NOTE` in
  `lib/referenced-variables.ts`) and names `pm.variables.replaceIn` (or the
  same call on one scope) as the fix, but there is no popover - editing a value the script will never read
  at runtime would be actively misleading.

Excluding a read-only editor is one mechanism now, not two (issue #1320). The
paint, the hover card and the popover are all installed by
`useEditorVariableTokens` - one call, per editor - and the gate is per
matcher inside it (issue #1786): the variable matcher only with a provider
above an editable editor, the time matcher wherever the language has one.
There is no model left to mark and no per-language provider left to answer
for one anyway. That is simpler than the
two mechanisms this used to take: a Monaco hover provider is registered per
*language*, not per editor, so the `json` provider answering for a request
body was the same
object Monaco asked about a response body, and an editor that painted tokens
had to mark its model (`lib/variable-token-models.ts`, since deleted) for the
hover to tell them apart. `readOnly` could not decide it either way - that is
an editor option, and the provider was handed a model.

**A `data.*` token has three states of its own** (issue #600), decided by
`describeDataToken` against `VariableSupport.dataColumns` - the contract the
collection chain declares, resolved leaf-to-root by `resolveDataContract`:

| In scope | Paint | Tooltip |
|----------|-------|---------|
| the column is declared | muted | "Data column - bound per iteration", naming the declaring collection |
| a contract exists, the column is not in it | **amber, double-underlined** (`text-warning-text`, #3499) | "Not a declared column of X", listing what is declared |
| no contract anywhere in the chain | muted | "Bound by the run's data file / per iteration" |

Amber rather than the destructive red an unknown variable gets: an undeclared
column still binds if the run's file carries it, so this is "check this", not
"nothing can ever answer this". None of the three offers to create a variable.
The `{{` autocomplete offers declared columns as a **Data columns** group beside
Variables and Dynamic.

**This chip row lives beside a `script.pre` / `script.post` element's editor
now** (issue #1553), as `ScriptReferencesRow` (`components/shared/`) - split
out rather than restored, because the row now has two hosts and used to have
two copies. Through issue #1075, both the request builder's script panel and
the collection's Script tab painted a **"Names mentioned:"** row above their
Monaco editor - `referencedVariables` (`lib/referenced-variables.ts`) split
`pm` reads from `{{template}}` mentions (issue #659, decision D16: the engine
never interpolates script source, so a green `{{base_url}}` chip promised a
substitution that never happens), and `describeDataToken` /
`describeColumnReference` / `describeScopedRead` painted the same
`DATA_TOKEN_TONE_CLASS` (`lib/data-token-tone.ts`) both the URL bar and the
Data tab's column audit use (issue #604), so a column one surface calls
declared is the one every other surface calls declared. Both script panels
were retired for a `script.pre` / `script.post` element edited through
`ElementList`'s bespoke form (`ScriptElementForm`,
`components/shared/ElementList/`) - a primitive under `components/shared/`
that cannot depend on either host's context, the same rule that keeps this
row out of it. `ScriptReferencesRow` instead takes the resolved answers
(`script`, `allVariables`, `getVariableOrigins`, `dataColumns`) as props, and
each host - `ElementsPanel.tsx`, `ElementsTab.tsx` - supplies its own
context's answers through `ElementList`'s `renderAboveForm`, a plain
per-element render callback that keeps `ElementList` itself as
context-free as before. One deliberate behaviour change from the two retired
panels: an ordinary `pm.*.get()` read now paints the resolved/unresolved
(`secondary`/`destructive`) pair on both hosts, where the collection's
`ScriptTab` previously painted every such read with a flat accent regardless
of whether anything defined it - the two panels had quietly drifted apart on
this one state, and a single shared implementation cannot paint it two ways.

**A reference carries what its accessor can see, not only how it was spelled**
(issue #1063). `referencedVariables` matched three accessors and left
`pm.variables` and `pm.iterationData` out, so a name read through either was
chipped nowhere at all - the quiet half of the written-but-never-read defect,
and the half no colour assertion catches. Each reference now also carries a
`reads` of `scope`, `merged` or `row`, because since #1007 a bound row answers
bare column names through `pm.variables`: the same name through
`pm.environment.get` is a variable read and through `pm.variables.get` may be a
column one, so the syntax alone can no longer decide what a chip may claim. The
decision is `describeColumnReference`'s, beside the helper, and it answers with
`describeColumnToken` - the same three states `describeDataToken` reaches for a
`data.*` name, split out of it so the prefixed and bare spellings share one
rule. A `row` read is a column in every state it can
be in, including "no contract declared", while a `merged` read is a column only
while the name is a declared column no scope defines, which is the line
`VariableInput` already draws for a bare `{{email}}`. Everything else keeps the
paint it had.

**A reference also carries *which* scope it reads, and a scoped read that its
own scope answers emptily is amber** (issue #1196). `reads: "scope"` said that
one scope answers and never which, so both chip rows could only ask
`allVariables` whether *any* scope defines the name - an answer about the winner
of the full ladder. An enabled, empty `shop_domain` at collection scope
therefore got the healthy accent while `pm.collectionVariables.get` returned
`''` and `{{shop_domain}}` in the URL bar resolved the environment's value: a
failing assertion with nothing on screen connecting it to its cause, and the
usual way in is a Postman import's initial-value placeholder. Each reference now
carries a `scope` of `environment`, `collection` or `global`, null for the
merged and row reads and for a template mention, and `describeScopedRead`
(beside the helper, so the two surfaces cannot disagree) joins it against
`useVariableResolver`'s `getVariableOrigins` - which both panels were already
handed and neither read. The chip is amber when that scope's own **last enabled**
definition is empty or absent while **the ladder's winner** is a different scope
holding a non-empty value, and the tooltip names both facts: what the read
returns, and where the value the author is looking at lives. The winner is the
test, not "some other scope has a value", because the two part company exactly
where the read's own scope is the one that wins: an empty collection row beside a
non-empty global is the collection's answer *and* the merged answer, and an
enabled environment row wins whatever it holds, so neither can be shadowed by
anything. Amber on those would be amber on healthy scripts. Amber and not destructive, for the same reason the
undeclared column is: the read works and the name resolves, it just does not
resolve there. The merged read never warns - `pm.variables.get` returns the
winning value and is the escape from this trap - and the tooltip prints sources
(`environment - Staging`), never values, because a shadowing definition may be a
secret. The engine is correct here and untouched: `js_pm_scope_get` returns the
stored empty string when an enabled row holds one, and `undefined` when none
does, which is exactly what these two states say. **The completion list inside
the accessor now says the same thing at typing time** (issue #1302): it offers
the scope's own definitions rather than the ladder's winners, so the trapped
name is offered at all, and its `detail` is `describeScopedRead`'s sentence -
one function, two surfaces, rather than a second cross-check written beside it.

**A run-time token receives pointer events; the overlay does not.** The overlay
is `pointer-events: none` so clicks reach the transparent input underneath and
place the caret, and each token wrapper opts back in for itself -
`EditableVariable` because it opens a popover, `RuntimeToken` because a tooltip
*is* its whole content and cannot open without a pointer event (issue #604: it
never had this, so neither `{{$guid}}` nor `{{data.email}}` could be hovered).
Opting in costs the caret, so the token carries the offsets of its own text and
a click puts the caret at the **near edge** - before the token when its left
half was clicked, after it when its right half was. The edges, not a position
inside: `{{data.email}}` is one atom to everything that reads it, and a caret
between its braces is how a keystroke corrupts the name.

**The keyboard splits the overlay the same way the pointer does, and along the
same line** (issue #1215). The layer used to be `aria-hidden="true"` as a whole,
which is right for what it mostly is - a repaint of text the `<input>` beneath
already carries - and wrong for the one thing it also holds: an editable token is
a `role="button"` that opens the variable editor, and a focusable control inside
an `aria-hidden` subtree is the `aria-hidden-focus` violation. Two commits that
never met, each correct alone. So the duplication now carries the attribute where
it actually is - the literal text either side of a token, which the input does
carry - and the tokens stay in the accessibility tree.

**Both kinds of token, and the run-time one took a second pass to get there**
(issue #1238). #1215 left it hidden on the grounds that it is not focusable,
which was true and is the reason it should not have been: its tooltip is its
*entire* content, and it carries the only statement of where the value will come
from - the generator's description, `not generated here` for an identity, and the
amber "Not a declared column of …" that is how a drifted contract is spotted at
all. All of it was mouse-only. A `tabIndex` on the trigger is the whole fix,
because Radix opens the tooltip on focus and points `aria-describedby` at what it
opened; the editable token's other half - `role="button"` plus Enter/Space - is
deliberately **not** copied over, since nothing about a run-time token is
activated and announcing a button that answers no key is worse than announcing
nothing. A disabled field drops every token to `-1`, both kinds alike.

They share **one** Tab stop between them, roving: the token holding it has
`tabIndex={0}` and the rest `-1`, Left/Right move between them and Home/End jump
to the ends, and whichever token takes focus keeps the stop. Without that, a URL
with five variables put five stops between the URL and Send. It is the roving
tabindex `design-system.md` describes for the collection tree, hand-wired rather
than taken from the tree's machinery: `useRovingTreeFocus` navigates
`[role="treeitem"]` and dispatches at the tree's own data attributes, so pointed
at tokens it would silently do nothing, and `focusTreeRow` (`tree-focus.ts`)
moves the stop by writing `tabIndex` onto DOM nodes - correct for rows that do
not re-render for it, wrong for a strip whose stop is a React prop. Arrowing
deliberately does not wrap - falling off the end leaves Tab as the way out.
Locate the layer in a test by `data-variable-overlay`, never by `aria-hidden`,
which now names the parts rather than the whole - and enumerate the strip by
`[data-variable-token] [tabindex]`, never by `[role="button"]`, which is the
editable token's trigger alone and quietly stopped meaning "a token" when the
run-time ones joined the strip.

**The field is a combobox, and it steers its own list.** `VariableInput` carries
`role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`
and a live `aria-activedescendant` - but only where a list can actually open
(a scope, or plain suggestions), because promising a list a screen-reader user
then cannot find is worse than promising nothing. The arrows and Enter are
handled on the input: `cmdk` reads them off its own `Command.Input`, which
neither `VariableAutocomplete` nor `SuggestionList` renders, so before #1215 the
keys were faked by dispatching a synthetic keydown at
`document.querySelector("[cmdk-root]")` - the first `cmdk` list in the
*document*, of which the app mounts four - and Enter clicked whatever
`[cmdk-item][data-selected="true"]` it found there. Both lists are now driven
through `cmdk`'s controlled `value` / `onValueChange`, stepping through the one
ordering `lib/variable-suggestions.ts` builds and `VariableAutocomplete` draws.
`cmdk` mints the listbox and option ids after the props it is handed, so
`CommandListboxProbe` reports them from inside the list for `aria-controls` and
`aria-activedescendant`.

**Only the `{{` list opens with a row lit.** The user asked for a variable
there, so Enter takes the first. The plain list (header names) opens over what
they are typing, so a lit first row would rewrite a complete name on Tab
(#3667). Its highlight stays empty - no `aria-activedescendant` either - until an arrow
key or the pointer picks a row; Tab and Enter commit only that explicit
highlight and otherwise fall through, so Tab still moves focus on. A row picked in
an earlier opening is forgotten when the list closes. The first
arrow from nothing lands on row 0, ArrowUp included (clamped, not wrapped).
`cmdk` reads an empty controlled `value` as "unset" and lights the first row
itself, so `SuggestionList` hands it `NO_HIGHLIGHT` (`ui/command.tsx`, the same
sentinel the command palette withholds its highlight with) for an empty `value`.

**The field moves the highlight; the list scrolls it.** That split is not free:
`cmdk` schedules its scroll inside `setState("value", …)`, the path its own
`Command.Input` arrow handling takes, and a highlight arriving through the
controlled `value` *prop* lands in a layout effect that assigns and emits with
no scroll at all. So the highlight walked to the right row and the list stayed
where it was - past the eighth entry, below the fold of `CommandList`'s
`max-h-[300px]`, the only way to see what Enter would insert was the mouse
(#1333). `CommandScrollIntoView` closes it the way `CommandListboxProbe` closes
the ids: mounted inside the list, reading the highlight from `cmdk`'s store
rather than from a prop, so a row the pointer highlighted and one the arrows
reached take one code path - `cmdk` opts its own pointer handler out of
scrolling, and `block: "nearest"` is why matching them costs nothing, since a
row under the pointer is on screen already. A group's heading rides in with the
first row of that group, matching `cmdk`, because the headings are what tells a
generator from a stored variable.

`EditableVariable` takes the scope as a **required** prop, because a token only
renders where there is one. `RuntimeToken` serves all three run-time cases - a
value produced when the request is sent rather than stored anywhere - and is one
component rather than three because they differ only in the words of the tooltip.

The namespace checks come **before** the scope lookup deliberately: `data.*` and
the identity names are both disjoint from the tiers, so a variable someone
happens to name `data.email` or `$vu` neither answers for the column or the
identity nor may paint the token as though it had. Reading
the scopes first would show a resolved token carrying a value the engine will
never send. The create offer is out of reach for both - a variable of either
name can never resolve, so offering to make one is a dead end that leaves the
token exactly as it was - but by two different mechanisms: `VariablePopover`
refuses it for a `data.*` name itself (`isDataVariableName`), while an
identity name never reaches the popover at all, the branch above returning
before `EditableVariable` is rendered.

**The popover names a bound row as the origin, above what it beat** (issue
#1064). The token paint above is unchanged - a shadowed bare name still paints
in the accent - but opening `VariablePopover` on one while a row is picked and
its column answers the name now lists the row first, unstruck and labelled the
origin, with the scope definitions it outranks struck beneath it.

Hovering moved with it, and had to: hovering reads and clicking edits are two
readings of one token, so a tooltip still printing the environment's value
while the popover named the row would make a single token say two things about
one send. `EditableVariable` takes the row's answer off the origins it already
fetches - not a prop of its own, so there is one answer to "what wins" and not
two - and shows it with a `Bound row` hint. A cell is never a secret, but a
secret it shadows is still never printed. What did **not** move is the paint:
the token's colour is decided as it always was.

**The list of definitions is drawn under every state, not only the resolved
one** (issue #1083). A name whose every definition is switched off has no
winner, so it does not resolve and reached the popover's undefined states - and
the list was rendered inside the resolved branch alone, so the case it was added
for could not display it. The reader was offered a form to create a name that
already existed and was one toggle from answering. The list now sits outside the
branch chain, gated on holding a definition the popover is not already showing
rather than on a count of entries, and the two undefined states say what it
means: the create offer notes that the name is defined below and switched off,
and the red sentence reads "defined, but every definition is switched off"
instead of telling the reader to go and define it. The red itself stays - the
token genuinely does not resolve. `data.*` is the one state with no list, for
the same disjointness reason it has no create offer.

**The create offer's scope choice is a `ToggleGroup`, and picking one keeps you
in the value field** (issues #1380, #1391). It was three hand-rolled
`role="radio"` buttons with a roving `tabIndex` and an arrow handler of their
own, sharing one flex line with the "create in" label and an `ml-auto` Create
button - 298px of content in a 266px row, so with all three scopes writable the
button painted 21px outside the card, which `PopoverContent` does not clip. Both
halves are primitives now: the choice is the app's segmented control, so Radix
owns the `radiogroup` and `radio` roles, the single tab stop and the arrow keys,
and Create sits in the same `flex justify-end gap-2` footer the edit branch uses
one state over, which is what takes the widest line back inside the card. The
"create in" label stacks above the control rather than sitting beside it, the
way `LoadTestConfigDialog` labels its own: beside it, the segments have 266px
less the label to live in, and the two widest UI faces the appearance settings
offer - System and JetBrains Mono - spend more than that on "Environment
Collection Global". Above it, the widest of the four measures 230px.
Selection follows focus, as a radio group's does - Radix moves the tab stop and
leaves selecting to a press, so each segment picks itself `onFocus` and an arrow
cannot light one segment while Enter creates in another. Enter on the focused
segment creates: a segment that has focus beside a value already typed leaves
Enter nothing else to mean. A mouse click hands focus back to the field, because
picking a scope qualifies the value rather than replacing it as the destination;
as plain buttons the chips kept the focus a click gave them, and the next
keystroke went nowhere. Create is refused while the field is empty:
`mergeVariable` stores what it is handed, so an empty value defines the name as
`""`, which resolves - the token stops reading as undefined and answers with
nothing.

Reaching the list into those states also reached the bound-row note into them,
and it could not be carried over as written: "the definition above still
resolves on a send that carries no row" is exactly what a switched-off
definition does not do, so a row shadowing only off definitions gets the other
sentence - dropping the pick there resolves nothing.

**`VariablePopover` is the mode switch; its two editing branches are their own
components** (issue #1887). `ResolvedValueEditor` (`ui/resolved-value-editor.tsx`)
is the resolved branch: the masked or revealed field, the secret's eye, the
auto-save sentence and manual mode's Save/Cancel, plus `SECRET_MASK`, the
fixed-width mask the origin list reuses. `CreateVariableForm`
(`ui/create-variable-form.tsx`) is the create offer: the value field, the scope
`ToggleGroup`, Create, the secret toggle (the Variables editor's key button;
while it is on the value field is a `SecretInput`) and the bound-row and
switched-off notes. Both are controlled. The popover keeps the edit buffer, the
reveal flag, the picked scope, the create's secret flag and the Enter/Escape and auto-save-on-close flow, because `PopoverContent`
unmounts its children on close and the close path is what saves, discards and
resets them; held in the form, a picked scope would not survive a re-open. The
chips beside the name (Secret, `data`, `row`, `undefined`) are `Badge
variant="chip"`.

It sits beside `KeyValueEditor` rather than inside the request builder because
every row of that table renders one: a shared table reaching into a feature
module for its cell input is the same inversion one level down (issue #567).

## `{{token}}` named in `deferredVariables`

**muted, dashed underline**, never the accent of a resolved token; the popover opens as for a stored variable (the definition is still editable) with "`{{token}}` is set by a pre-request script at send." above it

## Variable scope as a prop (`VariableSupport`)

`VariableSupport` (in `types/ui.ts`) is the variable slice of the request-builder
context - `resolveField`, `getAllVariables`, `getVariableOrigins`,
`updateVariable` (an edit passes the shown definition's `sourceId` as a fourth
argument, a create none and a fifth, `{ secret }`, which only a create carries,
#3695), `writableScopes` - as a plain object a caller hands in, plus
the optional `dataColumns` (the declared data contract in scope, issue #600).
`dataColumns` is optional *within* a scope rather than with it: absent means the
chain declares no contract, which is every workspace that has not opened the
Data tab.

`maskSecrets` is the other optional member: `useVariableSupport` builds it from
`getAllVariables()` *at the call*, never at memo time, so the memoised scope
holds no secret text, and it masks with `SECRET_UI_MASK` (`services/codegen`),
the same bullets the Params tab's "Sends" line uses. Absent means the scope
marks nothing secret.

It exists because reaching for the context instead made two primitives
unmountable anywhere but the request builder: `useRequestBuilderContext()`
throws with no provider above it, so `KeyValueEditor`, `VariableInput` and
`EditableVariable` could not render at all elsewhere, and the surfaces that
wanted key/value rows wrote their own instead (issue #564). A hand-rolled copy
of a primitive never receives the primitive's fixes.

The prop is **optional** on `KeyValueEditor` and `VariableInput`, and its
absence is a real state rather than a degraded one: a canned webhook reply has
no variable scope, so nothing resolves, no token paints and no autocomplete
opens. Inside the request builder every mount site passes
`useVariableSupport()`; `AuthPanel`'s `VariableTextInput` calls that hook itself,
since it is always under the provider.
