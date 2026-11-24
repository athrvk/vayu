---
description: >-
  The ui/ primitive library of the Vayu desktop app, built on Radix UI and cmdk.
---

# UI Primitives (`components/ui/`)

Primitives built on Radix UI + cmdk:

`badge`, `button`, `card`, `code-editor`, `collapsible`, `command`, `delete-confirm-dialog`, `dialog`, `dialog-cancel-button`, `disabled-hint`, `dropdown-menu`, `heading` (`Heading` and `HeadingSection`, the main pane's heading outline from `heading-level.ts`; see `docs/design-system.md`, Accessibility), `info-chip`, `input`, `secret-input` (masked field with a reveal toggle - client secret / passwords, and the variables table's secret rows, which is where the pattern was extracted from), `kbd`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `progress`, `separator`, `skeleton`, `suggestion-list`, `switch`, `tabs`, `textarea`, `tooltip`, plus variable-aware inputs: `variable-autocomplete`, `variable-popover` (with its two branches, `resolved-value-editor` and `create-variable-form`), `variable-scope-badge`, and markdown: `markdown-view`, `markdown-editor`.

## `input`

`Input` takes a `size` prop, the way `Button` does, and **states its size,
never its height** (#1830). The three sizes are the density-scaled floor
tokens, so Comfortable follows without a call site doing anything. The
size-to-token map is `input-size.ts`, which `VariableInput` reads too, so the
two fields cannot drift:

| `size` | Class | Default | Comfortable | Use |
|--------|-------|---------|-------------|-----|
| (none) / `"default"` | `h-control` | 28px | 36px | A standalone input |
| `"sm"` | `h-control-sm` | 24px | 32px | A dense standalone input: dialog rows, filters, a table-cell editor, a label beside its field |
| `"xs"` | `h-control-xs` | 20px | 24px | A field inside a `target` row: the inline renames in the collection, request, variables and element trees |

`xs` is the one size with more than a height. It is `rounded-sm`, has `px-1`,
and sits left of the row's content edge by its padding plus its 1px border
(`-ml-[calc(var(--spacing)*1+1px)]`), with a width that gives the offset back
on the right. That geometry is drawn for a label a `gap-2` from the icon or
badge before it: the text lands on the label's x, so it does not move when a
rename begins, and the border clears the icon by a step (2px at Default, 3px at
Comfortable). Every rename site writes `size="xs"` and nothing else;
`chrome-floors.test.ts` fails a `px-`, `-ml-` or `w-` beside it. Its border
takes the focus colour in place of the ring, so one edge draws. No `text-box`
trim, ever: with `py-0` it clips descenders and underscores (`input.test.tsx`).
A caller never writes an `h-*`, `size-*` or `h-full` class on an `Input`, a
`VariableInput` or a `SecretInput`: `chrome-floors.test.ts` fails the tag that
does. `SecretInput` forwards `size`, `onKeyDown` and `ref` to the inner
input, and puts `id` there too so a `<Label htmlFor>` names the field rather than
the wrapper `div`. `size` is the variant, not the native numeric `size`
attribute, which `Input` omits.

## `dialog-cancel-button`

`DialogCancelButton` is the only thing that draws a **Cancel** (issue #1693).
The word used to come in three variants - `outline` in five dialogs,
`secondary` in three, `ghost` in three, plus one hand-rolled `<button>` with a
copied class list - so which one a user saw depended on which dialog they
opened. It settles on `secondary`, matching `DeleteConfirmDialog`, and takes
no `variant` prop: a call site that can choose is a call site that can drift.
`label` renames the word, `size` and `className` pass through for the inline
forms outside a `DialogFooter` (the new-collection row, the client-certificate
form) that draw the same button in a denser row.
`dialog-cancel.test.ts` bans the label anywhere else. It is also the URL
bar's Cancel for a buffered send in flight (#3352); `StopRunButton` stays for
runs and streams, which have a run id the engine can stop.

## `disabled-hint`

`DisabledHint` says why a control is off (issue #1690). `Button`'s baseline is
`disabled:pointer-events-none` and a disabled button is not focusable, so a
`Tooltip` around it never fires; `DisabledHint` instead wraps the control in a
`span` that keeps its own `pointer-events-auto` and its own tab stop and holds
the tooltip, so the reason shows on hover and on Tab. `reason` is both the text
and the switch: falsy renders the children alone, so a caller passes one
expression (`<DisabledHint reason={empty && "No captures to clear"}>`) rather
than two copies of the control. The gate stays the child's `disabled` prop.
Crossing the gate swaps the child's DOM node, so a test must re-query it. A
disabled menu item is the exception: `RowAction`'s `disabledReason` draws the
reason on the item (see Row and tab actions menu above). The rule and the
wording guidance are in [design-system.md](../../design-system.md).

## `dialog`

`DialogContent` is a column flex panel with two caps: `max-w-xl` (the default of
a four-size width scale - `lg` / `xl` / `2xl`, issues #701 and #892, plus the
two-pane `max-w-xl lg:max-w-4xl`, issue #2231) and
`max-h-[85vh]` (issue #773). Anything between the header
and the footer that can grow goes in **`DialogBody`**, which is the band that
scrolls - so the title and the primary action stay on screen and the corner
close button, positioned against the panel, does not scroll away with the
content. The band also carries its own 4px/1px clearance (issue #1627), so a
focused field's outset ring is never clipped by the `overflow-y-auto` that
makes it scroll, and no call site needs to add its own. `ImportModal` and
`CommandDialog` opt out because each already has a
self-scrolling band of its own, and `DeleteConfirmDialog` has no middle at all;
every other call site takes the band, which `dialog-height-band.test.tsx`
enforces. `command` keeps the shape without the primitive: `CommandFooter` is a
`shrink-0` sibling of `CommandList`, so the palette's hints sit outside the one
thing that scrolls. The rules and the measurements are in
[design-system.md](../../design-system.md).

The `cva` definitions for `badge`, `button` and `toast` live in sibling
`*-variants.ts` modules and are re-exported from `components/ui/index.ts`. A
module that exports both a component and a value cannot be hot-reloaded, which
is the only reason for the split - import `badgeVariants` / `buttonVariants` /
`toastVariants` from `@/components/ui` as before.

## `progress`

A determinate or indeterminate bar over `@radix-ui/react-progress`
(issue [#882](https://github.com/athrvk/vayu/issues/882)). `value` is a fraction
0..1, or **null** when nothing stated a total to be a fraction of - a download
whose upstream declared no `Content-Length`. Null is not zero and must not
collapse into it: Radix drops `aria-valuenow` for it, and this adds `aria-busy`,
which Radix expresses only as `data-state="indeterminate"` (a styling hook that
tells a screen reader nothing). `label` is required, because a bar is a number
with no noun in it.

The indeterminate stripe animates through `.progress-indeterminate` in
`index.css`, so the global `prefers-reduced-motion` rule collapses it like any
other animation. Every caller of that state therefore also shows a figure that
keeps changing (bytes received): the information is in the text and the motion is
only the hint that something is still happening. Sole consumer so far is
`modules/collections/ImportProgressView.tsx`.

## `info-chip`

The 12px "i" dot with a tooltip, beside a label that needs a sentence -
timing phases, chart axes, the wire/queue/total summary. The hit box is 24px:
an `after:size-target` square centred on the dot, so no row moves. It lived in
`modules/dashboard/components/shared.tsx`, where nothing outside the dashboard
could import it without a module reaching into another module, so the request
builder grew its own copy - and the copy is the one that got the `border-rule`
fix, leaving the original outline-less in dark. The border stays a prop
(default `border-border`, pass `border-rule` on a declared surface) because
`border-rule` falls back to the invisible default where no surface declares one.
`dashboard/components/shared.tsx` re-exports it so existing imports resolve.

## `code-editor`

The single wrapper around Monaco. Every shared editor setting lives here so it
changes in one place, and it is also where Monaco is *loaded* - `ensureMonaco()`
on first mount, a skeleton until it resolves (see `lib/monaco-setup.ts` above).
The other half of its job is making an editor behave like the rest of the app,
because Monaco's defaults are not this app's and there are a dozen mount sites
to keep from each answering that separately (#938, #1213).

**Keyboard.** `lib/editor-chords.ts` binds the first four on every instance, and
`useEditorVariableTokens` the last on the editors that paint variable tokens:

- **The two send chords** (⌘↵, ⇧⌘↵), re-dispatched on `document.body` for the
  one window handler to decide. Monaco owns Enter and `ownsEnterKey` excludes
  editors from that handler on purpose, so without the bridge ⌘↵ inserted a
  newline in the body, GraphQL and script panes.
- **⌘I**, the context-bar toggle, for the opposite reason: Monaco binds
  CtrlCmd+I as a secondary `triggerSuggest` keybinding on every platform and its
  keybinding service stops what it resolves, so the chord died at the editor
  instead of reaching `Shell`'s bubble-phase listener. S, W, B, `,`, the digits
  and the ⇧ view chords really are unbound in the standalone editor and arrive
  on their own - which is what the bridge's comment used to claim about **all**
  of them.
- **⇧⌘M, the way out.** Monaco's Tab indents, which is right for a code editor
  and a keyboard trap for anyone who reached one by tabbing (WCAG 2.1.2).
  Monaco's own exit, `editor.action.toggleTabFocusMode`, cannot simply be
  advertised: it is Ctrl+M, which on macOS means ⌃⇧M - a modifier `Chord` has no
  word for - while the ⌘M this registry *would* render is Minimize. So the app
  declares `LEAVE_EDITOR_CHORD` and the Keyboard Shortcuts panel lists it like
  any other. It moves focus to the first focusable element after the editor's
  container, walking backwards when the editor is the last thing on the page -
  never to the container itself, whose textarea the next Tab would walk straight
  back into.
- **⇧⌘D, the variable under the cursor** (issue #1220). A `{{token}}` in a
  Monaco editor is painted text, not a `role="button"` a Tab can reach, so the
  mouse route into its popover (⌘/Ctrl-click) has no keyboard twin to inherit.
  `EDIT_VARIABLE_CHORD` is that twin: it reads the caret's own position, and it
  is bound where the token decorations are - per editor, in
  `useEditorVariableTokens` - because which variable to open is a question only
  the editor holding the caret can answer. Registered only where variables are
  painted, so a read-only viewer never carries it - not even one whose times
  are underlined, which have nothing for a chord to open. A script editor does (issue
  #1220 script support): the caret on a `pm.<accessor>.get(...)` argument or a
  `replaceIn(...)` template opens the popover the same way a body token does;
  on a bare `{{name}}` it does nothing, the same guard that keeps a plain click
  from opening one - there is no stored variable behind a mention the script
  never reads.

**A read-only editor has no trap to escape**: `tabFocusMode` is simply on for
it, Tab having nothing to indent in text nobody can type into, so it shows no
hint. The binding is still registered there, redundantly - one `addCommand` on
every instance is cheaper to keep true than a `readOnly` branch threaded through
the bridge. Editable editors keep Tab and show a `Kbd` hint naming the chord
*while they hold focus* - at the moment it is wanted, rather than as a standing
badge over a dozen panes. The hint is the app's one surface floating over
Monaco's own canvas rather than a declared app surface, so it carries
`border-border-strong` explicitly: there is no `--rule` for `border-rule` to
inherit, and neither theme's `--popover` separates from the editor background on
its own.

**A read-only editor draws every column** (#3140). It passes
`stopRenderingLineAfter: -1`; Monaco's default of 10,000 columns leaves the rest
of a line undrawn, which cut a minified response off mid-token. An editable
editor keeps the default, and a caller's `options` override either.
`code-editor.long-lines.test.tsx`.

⌘K is not bound here at all. It belongs to `CommandPalette`, on the capture
phase, which both prevents **and stops** it: preventing alone left the event in
flight, and Monaco - which treats ⌘K as a chord *leader* - entered chord mode
behind the open palette, so the next keystroke answered "not a command" in its
status bar.

**`ariaLabel` is required.** Monaco's default accessible name is "Editor
content", so a dozen unlabelled panes are one control to a screen reader. It is
per call site rather than derived from `language`, because two editors can share
a language and never a job (the GraphQL variables pane and a JSON body are both
`json`). The type holds the prop present; `code-editor.aria-label.test.tsx`
holds the labels non-empty and distinct, with a floor under the mount count so a
broken scan cannot pass vacuously. The two script panels take theirs from
`SCRIPT_VARIANTS`, the collection script tab from its `kind` - a scan cannot
follow either, which is the same limit that applies to class names arriving in
a variable.

**`path` is optional, and a shared editor needs one** (#3136). It names the Monaco model the editor shows, with that model's undo stack, cursor and scroll. An editor that serves several documents in turn (the request builder's body and GraphQL panes, across request tabs) gives each its own, because a changed `value` is applied to the model in hand as an undoable edit and undo would otherwise restore another document's text. The library never disposes a model on a path change, so whoever picks the paths ends them (`useRequestModelLifecycle`). The request builder's paths are built by `requestModelPath` in `modules/request-builder/utils/editor-models.ts`.

**Themed, not Monaco's default.** `theme` is `vayu-light` or `vayu-dark`
(#1321), never Monaco's own `vs` / `vs-dark` - both are defined once in
`lib/monaco-theme.ts`, inheriting the built-in theme's syntax colours and
repainting only the chrome (suggest list, find widget, hover card, context
menu) from the app's own tokens. Registration happens as Monaco composes
(`lib/monaco-setup.ts`, above), because an editor created before the app's
theme is defined falls back to `vs` and never revisits it; `useMonacoTheme`
then redefines the active theme whenever the mode or accent scheme changes,
from a `MutationObserver` on `<html>` rather than a React effect - `<Editor>`
is this component's child, and a child's effects run before its parent's.
`lib/monaco-theme.test.ts`, `code-editor.theme.test.tsx`, and the sixth case in
`monaco-setup.contributions.test.ts` guard it.

## Markdown (`markdown-view`, `markdown-editor`)

`MarkdownView` renders a description; `MarkdownEditor` wraps it in the
click-to-edit field used by the request **Info** tab and by
`CollectionDetail/InfoTab`. Both fields stored markdown and rendered none of it
before this existed - the collection one even advertised "Markdown supported"
beside a plain textarea.

**Three rules are load-bearing, not stylistic:**

1. **`MarkdownView` never emits a navigating anchor.** The preload re-runs on the
   new origin, so a clicked `<a href>` would hand `window.electronAPI` to
   whatever site it landed on. Descriptions arrive from imported Postman /
   Insomnia / OpenAPI files, which are third-party documents. Links therefore
   render as `<button>`, with no `href` in the DOM, and open via the
   `openExternalUrl` IPC (http(s) only, window must be focused, one open per
   second) through `lib/open-external.ts`, which the MCP result view's resource
   links use too. `remark-gfm` autolinks bare URLs, so that override covers those too. Guarded by `markdown-view.test.tsx`.

   This is no longer a single layer: #822 landed the refusal underneath it, so
   `electron/window-navigation.ts` makes the main window refuse a navigation that
   is not the app's own document and deny `window.open`; the app document also
   carries a Content-Security-Policy (`electron/renderer-csp.ts`). Keep both
   layers - the window guard turns an escaped link into a dead one, and this
   override is what makes it reach the user's browser instead.
2. **`react-markdown` with the default `urlTransform`.** It builds React
   elements from an AST, so there is no `dangerouslySetInnerHTML` and no
   sanitiser to forget. Overriding `urlTransform` disables the built-in URL
   sanitising (there is a published advisory for exactly that), so it stays on
   the default.
3. **Raw HTML renders, and `rehype-sanitize` runs immediately after
   `rehype-raw`.** `rehype-raw` used to be deliberately absent, which made raw
   HTML inert - fine until Stripe's official OpenAPI document turned out to
   write every operation description as HTML (`<p>Retrieves…</p>`), which is
   spec-legal and was on screen as literal text. The order is the rule: sanitise
   before the raw HTML is parsed and it sanitises a tree the payload is not in
   yet. The schema is derived from the component's own element allow-list, keeps
   `href` on an anchor and **no other attribute** (`class` least of all - the
   cheap attack is `<p class="fixed inset-0 z-50">`, not a script), passes
   http(s) only, and strips `script` and `style` whole rather than unwrapping
   their text onto the screen. Guarded by the benign and hostile blocks in
   `markdown-view.test.tsx`, which are also what pin the plugin order.

The pipeline itself - `react-markdown`, the plugins, the schema and the
component overrides - lives in `markdown-renderer.tsx`, which `MarkdownView`
loads through `React.lazy` (#1146). `MarkdownView` reaches the entry chunk
through the `ui` barrel, so an eager parser chain here was ~300KB parsed on
every cold start for a panel most sessions never open. The three rules above
are unchanged by that: they live with the pipeline. What it changes is the
tests - a case that asserts rendered output has to let the chunk arrive first
(`markdown-view.test.tsx`'s `renderView` helper is the shape).

`MarkdownEditor`'s rule is **focus, not dirtiness**: rendered while unfocused,
source the moment you click in. The caret goes to the end - mapping a rendered
offset back to a source offset needs a real WYSIWYG editor. `keepSourceOpen`
holds the source open for a caller whose save failed, and a source pin (Obsidian's
"source mode") lets you read your own markdown without editing.

## `suggestion-list`

A plain-text dropdown on the shared `Command` primitive, used by
`VariableInput` for header-name suggestions. It replaced a hand-rolled copy in
that file - its own selected-index state, five keyboard branches, a render-phase
index reset and a 200ms blur timeout - all of which `cmdk` already did, two
branches away in the same component, for variables.
