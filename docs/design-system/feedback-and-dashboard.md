---
description: >-
  Toasts, inline rename, copy feedback, times, disabled hints, destructive actions and the dashboard header, metric cards and progress bar.
---

# Toasts, feedback, destructive actions and dashboard components

## Toasts

Transient report of an action the user just took.
The queue is `stores/toast-store.ts`; the surface is the shadcn/Radix primitive in `components/ui/toast.tsx`, rendered once by `components/shared/Toaster.tsx`.

**Four things about toasts are user-configurable** (Settings -> Notifications, persisted in `client-settings-store` as `notifications`, options and defaults in `constants/toast.ts`):

| Setting | Values | Default | Applied |
|---------|--------|---------|---------|
| `position` | 6: each corner plus top/bottom centre | `bottom-right` | `Toaster` (viewport class + swipe side) |
| `durationScale` | `short` 0.5x, `default` 1x, `long` 2x, `never` | `default` | at enqueue |
| `maxVisible` | 1-8 | 4 | at enqueue |
| `minSeverity` | `all`, `warning`, `error`, `none` | `all` | at enqueue |

Three of the four are resolved **when a toast is enqueued**, not when it is drawn, so changing them does not restyle what is already on screen.
That is why the panel has a Preview button.

The duration setting is a **multiplier over the per-variant durations in the table below**, never a replacement for them: those are tuned so a failure outlasts a confirmation, and a flat "5 seconds for everything" would throw that away.
`never` resolves to a 24h sentinel rather than `Infinity`, because the primitive arms a real `setTimeout` and a non-finite delay there is coerced to 1.

**Every position clears the chrome on its own edge**, via `--dock-height` at the bottom and `--titlebar-height` **plus** `--tabstrip-height` at the top - never a round number.
The top edge is two bands since the shell split the title row from the tab strip, and clearing only the first put the stack back on the chrome 32px lower.
The stack is `position: fixed`, so it anchors to the window rather than the layout, and a plain `bottom-4` once put it on top of the Dock.
`toast-position.test.tsx` checks all six.

**The icon carries the variant; the rail reinforces it.**
Never colour alone.
The version this replaced signalled variant with a 40%-alpha border and nothing else: `border-destructive/40` measured **1.16:1** against the toast surface in dark and 2.01:1 in light, while success's equivalent measured 2.21 / 1.42 - so the two were not reliably tellable apart in either theme, and error was effectively invisible in dark.
All four variants now come from one token family:

| Variant | Icon | Rail (a rule) | Glyph (a foreground) | Duration |
|---------|------|---------------|----------------------|----------|
| `info` | `Info` | `border-l-border` | `text-muted-foreground` | 4s |
| `success` | `CheckCircle2` | `border-l-status-success` | `text-status-success-text` | 4s |
| `warning` | `AlertTriangle` | `border-l-status-warning` | `text-status-warning-text` | 6s |
| `error` | `XCircle` | `border-l-status-error` | `text-status-error-text` | 10s |

Measured against the popover surface, light / dark:

| Variant | Rail | Icon |
|---------|------|------|
| `info` | 1.30 / 1.00 | 5.61 / 6.77 |
| `success` | 2.30 / 7.53 | 5.71 / 8.81 |
| `warning` | 4.00 / 4.34 | 5.46 / 9.81 |
| `error` | 3.78 / 4.59 | 5.88 / 5.85 |

Two of those rows look wrong and are not.
**`info` is the neutral variant and takes no accent rail on purpose** - `border-l-border` is invisible against the toast's own fill, and absence of a rail is itself the signal.
And **success's rail on white is 2.30**, under the 3:1 a graphic needs when it is the *sole* carrier of meaning.
It is not the sole carrier: every icon clears 5.4:1 in both themes.
That is the whole reason the icon exists.

The rail and the glyph take **different tiers of the same family on purpose**: a rail is a rule and takes the bare `--status-*`, a glyph is painted with a `text-` utility and takes `--status-*-text`, the tier tuned to be read against a background.
`status-color-tokens.test.ts` enforces the second half repo-wide.
Neither ever takes `--status-*-fill`, which is only correct under a white label.

The shell keeps `bg-popover` with a `border-border` edge.
That edge faces the canvas, which is the case `border-border` is for.
It is deliberately **not** `border-rule`: no `surface-popover` class is declared, and `border-rule` under no declared surface falls back to the invisible default.

**The stack sits above the Dock, not on it** - `bottom-[calc(var(--dock-height)+1rem)]`, keeping the same 1rem of air it has on its right edge.
See **Geometry** for why that is a token and not a literal.
It also clears dialogs at `z-50` on `z-[100]`, which is hit-tested rather than assumed, since a dialog portals to `body` while the viewport lives in `#root`.

**The stack is `w-xs` (20rem) at both densities.**
Its width is a text measure, not rhythm, so it stays off `--spacing`: the `w-80` it replaced was 240px at the Default density, a ~160px text column that wrapped `Moved "<name>" to the Trash` for almost any name.
Inside it, the action sits at its own width (`self-start` in the text column, which is a `flex-col` and would otherwise stretch it), and the title and message take `break-words`, since the toast is `overflow-hidden` and a name can be one unbroken operation id.

Durations are floors, not limits - the primitive pauses them on hover, focus and window blur.
A failure gets longer than a confirmation because it often carries a cause from the engine ("database is locked") that takes longer to take in.

**Queue policy** lives in the store, because the primitive has no opinion on it: an identical message and variant already on screen is collapsed rather than stacked (the OAuth2 guard retries; an SSE stream can fail on every reconnect), and past four the oldest is dropped so a burst cannot run off-screen where it is unreachable and undismissable.

**Everything is polite, including errors** (`type="background"`).
A toast dismisses itself on a timer and always reports something the user just asked for, so interrupting what they are reading is the wrong trade.

## Inline rename

Every tree that renames a row in place does it through one hook, `app/src/hooks/useInlineRename.ts` - the collections tree, the variables sidebar's environments and the element list (four call sites).
The field is an ordinary `Input` at `size="xs"` replacing the row's `cap-centred` label, so its text keeps the label's position on both axes: every renaming row puts its label a `gap-2` from the icon or badge before it, the gap `xs`'s pull-back is drawn for (see the floors table), and the field states `size="xs"` and nothing else.
The hook takes a required `label` ("Request name") that names the field for a screen reader: it replaces a row's name and has no visible label, so it would otherwise be a bare "edit text" (#3498).
The hook owns the behaviour:

- **Enter commits only through `isCommitEnter`** (`@/lib/keyboard`), never a bare `e.key === "Enter"`.
  An IME commits its composition buffer with an ordinary Enter keydown, and `mod+Enter` is the app's Send chord - a field acting on it renamed the row *and* sent the request from one press.
  `commit-enter.test.ts` fails on any new bare comparison outside the hand-rolled activation controls it names.
- **Escape never commits.**
  The cancel unmounts the field and the blur that follows is the one the cancel caused, so the hook closes the editor once and that blur does nothing.
  A blur the *user* caused still commits.
- **The name is trimmed, and an empty one cancels** rather than erasing a name.
  The one exception is a field whose entity has an optional name (an element row falls back to its kind label), which asks for `commitEmpty`.
- **Focus returns to the row after a keyboard close, never after a blur.**
  Each tree is one tab stop and the field replaces the row's only focusable control, so an Escape that left focus on `<body>` would drop the user out of the tree.
  After a blur, focus has already gone where the user put it.
- **The field opens with the whole name selected** (#3450), as Finder, Explorer and VS Code do, so typing replaces the name instead of appending to it.
  The hook's `onFocus` selects it and the field's `autoFocus` triggers that on mount, which is why the hook sets the draft during the render that opens the rename rather than in an effect: a field that mounts empty would select nothing.

A surface that renames something in place uses the hook rather than a fifth copy of those five rules.

## Copy feedback

A copy is acknowledged one of two ways, and which one is decided by the control, not by the surface:

- **An icon button swaps its glyph**: `IconSwap` from Copy to Check, through `useCopy({ feedback: "icon" })`.
  No toast beside it - the swap already said it.
  A button that carries a glyph of its own swaps that one (the issuer's signing key swaps its key for the check).
  That is the trash entry, example row and variable row; the shared `CopyForAgentButton` (the capture header, run sample header, spec sync operation row, threshold verdict check, load test budget field and GraphQL body);
  and every URL copy button: the inbox and mock-server tab headers', the collection header's mock server chip, and the Services drawer's issuer discovery, metadata, token and authorize URLs and signing key (#2315).
  Each button owns its own `useCopy` instance, so a copy checks the glyph it came from and not a sibling's.
- **A menu item or a text button toasts**: plain `useCopy()`, whose toast names the value that was copied, so a surface with several copy controls says which one it means.
  A row's "Copy for agent" item is the example: its toast reads "Reference copied", not "Copied".
  The text-button side is the inbox and mock-server tab headers' "Copy for agent" (#2047), which sit beside an icon button for the URL and so keep a hook instance of their own.
  A text button that stands alone may instead swap its label in place with `LabelSwap` ("Copy install command" to "Copied" in the updates card, "Copy" to "Copied" in the MCP settings panel); a text button among several siblings toasts, because the toast is what says which of them landed.

**One duration, `TIMING.COPY_RESET_MS`, and the hook owns the timer.**
This used to be three - 1500ms in the MCP settings panel, 2000ms in the two update surfaces, `STATUS_RESET_MS` in the response viewer and the snippet section - because each call site kept its own `copied` flag and its own `setTimeout`.

**Every clipboard write goes through `useCopy`.**
`navigator.clipboard.writeText` rejects on a denied permission, an unfocused document, or a platform with no clipboard behind the API, and a call site that awaits it with no catch simply never reaches the line that draws the feedback: the copy fails and the user's only evidence is pasting the previous clipboard contents somewhere else.
`clipboard-single-writer.test.ts` holds the rule to two files - the hook, and `errors/ErrorBoundary.tsx`, which runs when the tree below it has already failed and no hook is reachable.

**A failure toasts in both modes.**
An icon button has no failure glyph, and a check that simply never appears is the same silence again.

## Times

Wherever Vayu shows a time, the user's own zone, UTC and how long ago are one hover away (issue #1786).
The rule is every surface, not a list of them.

- **The visible text keeps its shape.**
  A run's start reads as a date and time, an inbox row as a wall clock, a list row as "2 hours ago"; an API value in a header or a body stays exactly the machine string it arrived as.
  The card adds to the text and never replaces it.
- **The card has a zone row and a UTC row, and a relative row unless the visible text is already relative.**
  The original text is not repeated: it is what was hovered.
  The rows are set at the 11px `text-label` step so the card stays small.
  The zone row is labelled with the IANA zone the OS resolves, so a screenshot says which zone it was taken in.
  A value that names no zone (`2026-10-05`, `2026-10-05T08:10:00`) is shown as written with a line saying so, because converting it would invent an instant.
- **The relative phrase comes from the platform** (`Intl.RelativeTimeFormat`), so it reads in the user's language and pluralises as that language does.
  Nothing hand-wraps it: no `"5m ago"` ladder, and copy never builds a phrase around a count of minutes.
- **`TimeValue` is the only renderer.**
  It takes an instant or the raw text and a style (`datetime`, `date`, `time`, `time-ms`, `relative`, or `raw` to keep the string as it came), renders a `<time>` and carries the card through the `Tooltip` primitive.
  The card's rows are built when it opens, so a list of hundreds of rows pays for the text only.
  A value that is not a time renders as plain text with no card.
- **A string that cannot hold an element** - an `aria-label`, a native `title`, a palette subtitle - calls `formatInstant` from `lib/time-value.ts`, the same formatter `TimeValue` uses.
  That is the only other place a time may be formatted.
- **API data in a table is decided by `parseTimeValue`, never `new Date()`**, so `1` or `2026` in a field is not a time.
  A header value wraps each time run it holds in a `TimeValue` and leaves the rest as received: a `Date` value is one run, a `Set-Cookie` has its `Expires=` date marked among its other attributes, `Content-Type` has none.
  The Cookies tab lists those attributes one chip each and renders every chip through the same `HeaderValue` (exported from `HeadersViewer.tsx`), so an `Expires=` date there carries the card as it does on the Headers tab.
  An editable field (a request header or param, a variable) cannot hold an element, so the card hangs off a `TimeMarker` beside it - a clock button in the key-value table's marker column, inside the field in the variables table - rather than off the field, which would open on every focus and cover the autocomplete.
  **A secret variable never gets one**, saved or not: the card is a tooltip a screen share catches.
- **A surface with no visible time** puts the card on a trigger of its own with `TimeTooltip`: a history row hangs it off the row's stretched activator, with the status and the run's comment as extra rows, in place of the native `title` that used to say the same in one unnamed zone.
- **No setting.**
  The OS locale and zone decide, as they always did.
- **A test that renders a time needs a `TooltipProvider`** above it: `@/test/render-with-tooltips` is Testing Library's `render` inside one.
- Monaco editors underline a time by the same parser and draw the same rows, the Raw tab's `http` language included; see `docs/app/COMPONENTS/shared-variable-input.md`.

→ `time-surfaces.test.ts` reads every source file under `app/src` and fails on `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString` on a Date, `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` outside `lib/time-value.ts` and `components/shared/TimeValue/`, and on any `CodeEditor` that opts out of the time matcher.
`Number#toLocaleString` for counts is untouched.
It also pins `ResponseCookies.tsx` to `HeaderValue` or `TimeValue`, because a time shown unformatted is invisible to the scan.

## A disabled control says why: `DisabledHint`

A gated control that gives no reason reads as a broken one, and the obvious fix does not work: `Button`'s baseline is `disabled:pointer-events-none`, so a `Tooltip` wrapped around a disabled button never receives the pointer events its trigger listens for, and a disabled button is not focusable either.
Both paths to an explanation close at the moment there is something to explain.

`DisabledHint` (`app/src/components/ui/disabled-hint.tsx`) is the wrapper that keeps them open - a `span` with its own `pointer-events-auto` and its own tab stop, holding the tooltip, with the inert control inside it:

```tsx
<DisabledHint reason={captures.length === 0 && "No captures to clear"}>
  <Button disabled={captures.length === 0}>Clear</Button>
</DisabledHint>
```

- **`reason` is the switch as well as the text.**
  Falsy renders the children alone, so one expression covers both states rather than two copies of the same button - which is how a hover class or an `aria-label` ends up on one of them and not the other.
- **The gate stays the child's `disabled` prop.**
  This adds the explanation and changes nothing about what refuses the click.
- **The reason names the state, not the remedy in full.**
  "No captures to clear", "Already first", "No unsaved changes" - one line, present tense.
  A sentence that needs more than that belongs beside the control, as the elements list's missing-field note already is.
- **A disabled menu item is the exception.**
  `RowAction`'s `disabledReason` (`components/shared/row-actions.ts`) draws the reason on the item itself, because a tooltip inside a menu's focus trap competes with the menu for the keyboard and Radix deliberately skips a disabled item.
  Both menus get it at once through `RowActionBody`.
  See Row Actions.

## Destructive Actions

Three shapes, and each has a component rather than a recipe to copy:

- **A banner** (an error or warning about the form or pane) is `Callout` (`components/shared/Callout.tsx`) with `severity`, which owns the tint, the glyph and the `-text` foreground.
  A hand-rolled `bg-destructive/10` box is the drift it replaced.
- **Stop** is `StopRunButton` (`components/shared/StopRunButton.tsx`): a destructive outline over `ghost` with the label on `text-destructive-text`.
  The bare `text-destructive` is a fill token and is not a foreground (see Semantic Status Colors).
- **A row's delete** is a `TooltipIconButton` with `variant="rowActionDestructive"`, so its label shows on focus as well as on hover (#3498), revealed per Row Actions above.

### Reversibility

Two lanes, decided once here rather than per module (issue #1683/#1689):

- **Collections, requests, environments, saved examples and client certificates go to Trash, with Undo.**
  Deleting any of them is recoverable for the retention window Settings shows - the undo toast (`hooks/useTrashUndo.ts`, one for every Trash-bound delete) handles the immediate "I clicked the wrong row", and Trash's own restore handles everything after that.
  Environments joined in #2970 (item 1 of #2431) and saved examples in #2971 (item 2) and client certificates in #2973 (also #2431), and their deletes still open `DeleteConfirmDialog` first, with copy that points at the Trash rather than calling the delete final: the Trash-bound deletes that ask.
  Only a *saved* example is trashed: an imported one is a spec-sync tombstone, its dialog keeps the sync and re-import wording, and no Undo follows.
  A certificate's purge from the Trash is the one place its stored passphrase is destroyed, so that dialog says so (and that the files on disk are untouched); a restore the engine refuses because a live entry holds the host and port shows the engine's message.
- **Everything else confirms and deletes permanently**: history runs, load-test examples, inbox listeners and their captures.
  The owner decided this deliberately (#1683) - a second Trash lane for every other entity is not coming, so a module reaching for one should reach for `DeleteConfirmDialog` instead; #2431 is where the owner names the entities that do join it.
- **A destructive action never runs from a single click without one of the two.**
  A control that removes data either lands in Trash (no confirm needed
  - it is reversible) or opens `DeleteConfirmDialog` (no Trash - it is not).
  Wiring a mutation straight to a button's `onClick` for anything that destroys data is the bug this rule exists to catch (#1689's Clear captures and Empty trash were both found this way).
- **One template writes the sentence.**
  `DeleteConfirmDialog` takes `name` and builds "Delete {name}? {name} is removed permanently." itself.
  A call site passes `description` only for prose the template cannot say - a count, a conditional clause - never to restate what `name` already produces.
- **A refusal goes in the `error` slot.**
  A delete the engine refused is a `<Callout severity="blocking">` passed as `error`, rendered between the description and the actions.
  It is a slot of its own because `DialogDescription` is a `<p>` and a `Callout` is a `<div>`; a bare red `<span>` inside `description` is the shape this replaced.

## URL Bar (Flat Style)

The reference is `app/src/modules/request-builder/components/UrlBar/index.tsx`, and its header comment carries the reasoning; this section is the summary, not a recipe to copy.
One `h-control` row: the method and URL as a single `bg-card surface-card` field, then Send and Load test attached as a pair.
Send is the solid action on `bg-primary-fill` with a white label, reads "Send" (or "Sending…" while in flight) and carries no leading glyph; Load test is the outlined action on the same accent and reads "Load test".
Both are token-based: no hardcoded purple, no bracketed pixel heights.
Each hover is an opaque step of its own ground: Send goes `hover:bg-primary-fill-hover` (border with it), Load test goes `bg-primary-tint` to `hover:bg-primary-tint-hover`, and a disabled Load test pins `disabled:hover:bg-primary-tint` so it does not step at all.

## Dashboard Header (Compact 52px)

The reference is `app/src/modules/dashboard/components/DashboardHeader.tsx`: an `h-band-lg` row on `bg-panel` whose bottom edge is `border-rule`, holding the run's status pill (`RunStatusPill`), a `MethodBadge`, the URL, a config summary and `StopRunButton`.
The band height is the `--spacing-band-lg` token, not a literal; see Chrome, Target and Icon Floors.

The header's elapsed time is the `elapsedDuration` prop, the newest tick's `elapsed_seconds` from the engine, so it starts at 0 with each run and holds no timer of its own.

## Hero Metric Card

The reference is `app/src/modules/dashboard/components/hero/HeroCardShell.tsx`, which every hero card is built on: a `Card pad="md"` with an eyebrow label and its `InfoChip`, then a body.
The usual body is `HeroValue`, a `text-hero` mono value with an optional unit beside it; two cards add a `MiniBar` fidelity gauge below, and a few supply a bespoke body of their own.

## Secondary Stat Card

The reference is `app/src/modules/dashboard/components/stats/StatCard.tsx`: the same anatomy as the hero card at the `Card pad="sm"` (`p-3`) tier, with a `text-metric` value.

## Progress Bar

`components/ui/progress.tsx`, over `@radix-ui/react-progress`.
Track `h-1.5 w-full overflow-hidden rounded-full surface-sunken`; fill `h-full rounded-full bg-primary`.

Three choices worth stating, because each has a plausible wrong answer:

- **`bg-primary`, not `bg-primary-fill`.**
  `--primary-fill` exists for solids that carry a white label; a progress fill carries none, so it follows the accent rule and brightens in dark like every other accent surface.
- **`surface-sunken` for the track.**
  It is the one recessed fill that reads on a card in both themes (1.356 / 1.343), and on `--muted` / `--accent` no border token works at all - see the borders section.
- **`rounded-full`, not a radius token.**
  A track is a pill at every roundedness setting, which is that setting's documented fixed-radius exemption.
  A bare `rounded` would pin it to 4px and fail `radius-token.test.tsx`.

Determinate sets the fill's `width` and transitions it (`transition-[width] duration-200 ease-out`).
Indeterminate is a `w-1/3` stripe crossing the track via `.progress-indeterminate` - growth from the start would read as a fraction, and there is no fraction to report.
