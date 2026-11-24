---
description: >-
  Component patterns: the states of a data pane, error text, tab strips, loading, cards, eyebrow labels and status badges.
---

# Component Patterns

## Empty, error and loading - the three states of a data pane

Every pane backed by a query needs all three, and they were each hand-written before: casing split two ways ("No Run Selected" vs "No collections yet") and structure ranged from icon + heading + description + action down to one bare line of muted text.
Three shared primitives in `components/shared/` now cover it.

| State | Component | Notes |
|-------|-----------|-------|
| Nothing here yet | `EmptyState` | `variant="inline"` for a single muted line inside a list; default is the centred icon + title + description. Both variants take an `action`. Inline takes no `description` or `icon`, enforced by type: fold the sentence into `title` (a `ReactNode`, phrasing content only, so a `<code>` type name can sit in it). A pane `description` is a `ReactNode` rendered inside a `<p>` (phrasing content only), which is how the response pane keeps its Send chord `Kbd` caps. Every empty line in a card or pane goes through this component, not a bare `<p>` (Settings > Files, Cookies and Client certificates are `inline`, #2320). `compact` (inline only) is `p-3 text-xs` for a dense surface - a drawer tree, a dialog's list box, a card - in place of the default `p-8 text-sm`; a call site does not override the padding itself. The context bar's `SectionEmpty` is this component (inline, compact), so every section's empty body is one. `empty-state-lines.test.ts` fails on a `<p>` that begins "No " or "Nothing matches" in `modules/` or `components/`, and on a `SectionEmpty` that stops rendering one, #3501 |
| It broke | `ErrorState` | Takes the raw `detail` and an `onRetry` |
| Still loading | `DetailSkeleton` | `rows` prop, default 4 |

A pane title (`EmptyState` and `ErrorState` alike) is a heading at the main pane's outline level - the tab's `h1` when the state is the whole tab, an `h2` under it otherwise - and a paragraph in the drawer and the context bar; see Accessibility (#3498).
The inline variants are a line, never a heading.

**An empty state that has a create path says so** (issue #1693).
Thirty-odd call sites had one between them before, so "No environments" and "No mock running" were dead ends whose only way forward was a tooltip icon button one row up.
Twelve now carry `action={<Button variant="link">…</Button>}`, wired to the *same* handler that header button uses - never a second, parallel create path, which is what would drift.
Where the surface genuinely has no create of its own the action points at the surface that does ("Browse collections" from the mock pane), and where the state is one the user caused it undoes that.
The wording is one pattern: "Clear the filter" for a single search or filter field, "Clear the filters" where several narrow the list (History).
A list that is empty because of what was typed says what was typed and offers the way out: Settings search's "No settings match", the Send-with-row dialog's "No rows match" and the schema explorer's "Nothing matches" carry a `variant="link"` "Clear the filter" that empties the field.
The collections sidebar offers its create path plus Import as a two-`Button` `flex gap-2` wrapper ("New request", "Import") rather than a lone link (`CollectionTree.tsx`): with no collection to hold it, a new request is what makes the first one, as its description says.
A pane that is a selection prompt ("No run selected"), a not-found, a loading step or a wait on someone else's traffic gets none: there is nothing to offer.
The `inline` variant takes an action for this reason - the drawer's group notes are inline and are where most of the dead ends were - and renders it under its single line, so the note stays one column wide inside an inset group.

**`ErrorState` is deliberately not a variant of `EmptyState`.**
"Nothing here yet" and "this failed" are different messages with different affordances, and folding them into one component with a flag makes it easy to show the wrong one.
`ErrorState`'s icon is not a prop, either - one symbol for all failures.

**The bug underneath the inconsistency is worth knowing.**
`useQuery` destructured as `{ data = [] }` with no `throwOnError` resolves to `[]` when the request *fails*, and never reaches an ErrorBoundary - so six screens told the user their workspace was empty when the query had simply errored.
When adding an error pane, gate it on `length === 0`: TanStack keeps last-good data through a failed background refetch, and covering still-valid content with a full-pane error is its own regression.

Sentence case for titles, everywhere.

## Error text has three levels, and one component each

| Level | What it is | Component |
|-------|------------|-----------|
| Field | One control refused one value | `FieldError` |
| Block | A condition about the form or the pane, which may stack with others | `Callout` |
| Pane | The thing you came to look at did not load | `ErrorState` |

Field-level messages were hand-written before, in `text-sm`, `text-xs` and `text-[11px]` - the import dialog carried all three - some with a leading glyph, some announced and most not.
`FieldError` is one size (`text-xs`; the sizes were the order the code was written in, not a hierarchy) and always `role="alert"`, because a message that appears after a keystroke is a change nobody is looking at.

A follow-up notice about a file that imported (the import preview's `NoticeList`) is not a `FieldError`: the file worked, so the line is drawn `text-warning-text` or muted, and it is not announced as an alert.
The preview as a whole sits in one `role="status"` region; only a real failure (the fetch, the apply, a file that did not parse) is an alert.

`text-destructive-text` is not by itself an error message: it is also the right foreground for a failure count, a "not defined" chip and the Dock's "Not saved".
`error-presentation.test.ts` draws the line where it can be drawn mechanically - the token in a literal class string on the opening tag of a text-bearing element (`<p>`, `<span>`, `<div>`, `<small>`, `<label>`, a list item, a table cell, a heading) - and every deliberate exception is named in that guard with what the red text is instead, rather than the rule being widened until it passes.

## Tab strips: one trigger look, three band chromes

The trigger has been shared for a while; the band around it was not.
Seven call sites carried seven recipes - `mx-5 mt-3`, nothing at all, `w-full px-1`, `px-5` with a `border-b bg-panel`, `w-full px-4`, `bg-panel px-4`, and `px-3 py-1.5 border-b border-rule bg-muted/30` - so the same control read as a different piece of chrome in every pane.
`TabsList` takes a **required** `variant`, and there is no default: a new strip says which of the three it is rather than inheriting whichever call site happened to be written first.

| Variant | Classes | For |
|---------|---------|-----|
| `pane` | `border-b border-rule bg-panel px-4` | The strip *is* the pane's chrome band - dashboard, Collection Detail, the import dialog, the unified response viewer |
| `inset` | `px-1` | A strip inside content that is already padded; the padding only keeps the first trigger's focus ring off the edge - the request strip, the load-test detail |
| `bare` | none | The band belongs to a parent row that holds other things beside the tabs - the response pane's strip shares its row with the response's facts and its actions |

`bare` is not a fourth look.
It is `pane`, drawn by whoever owns the row; the list adds nothing so the two cannot paint two rules a pixel apart.

The fill is `bg-panel` and the divider is `border-rule` with no surface class beside it - `bg-panel` is the `:root` default surface, the one place where the fallback value of `--rule` is the right answer (see "`border-rule`: let the surface pick the token").
Guard: `tabs.test.tsx`, both the rendered class lists and a scan asserting every call site in `app/src` declares a variant.

## Loading

Three shapes, one rule each, decided once here rather than per module (issue #1683/#1689) because the app had accumulated `Loader2` in 35 files, `ListSkeleton`/`DetailSkeleton` in about a dozen, `EmptyState`'s `iconClassName="animate-spin"`, and `ImportProgressView` - four idioms with nothing saying which one a new screen should reach for.

- **First load of a list or pane is a skeleton.**
  `ListSkeleton` or `DetailSkeleton` - the shape of the content that is about to appear, so the layout does not jump when it arrives.
- **An in-place action on an existing control is an inline spinner.**
  `Loader2` (`size-icon` or `size-icon-sm`, `animate-spin`) inside the button or row that triggered it - Send, Stop, Save, a per-row purge.
  The spinner is always that glyph: a bordered `div` with a transparent top edge is a further idiom, and `loading-idioms.test.ts` fails on it.
  The control that was clicked is what shows it is working; nothing else on the pane should move.
- **A multi-step job is a progress view.**
  `ImportProgressView` and its kin - several named steps with their own state, not a single spinner standing in for all of them.

A screen reaching for a fourth idiom, or for the wrong one of these three, is the bug this rule exists to catch.

**Refreshing something already on screen is none of the three: it is a dim.**
A skeleton and a full-pane spinner both begin by throwing away the content the user is reading, which is right for a first load and wrong for a re-fetch - re-sending a request whose response is on screen would blank the response pane, so the exchange being replaced would be gone from the press of Send.
The rule is the second bullet's, read to its end: the control that was clicked shows the work, and *nothing else on the pane moves size or position*.
So the stale content stays exactly where it is, the pane takes `aria-busy` and drops to `opacity-60` with a `transition-opacity duration-150`, and the dim lifting is what says the new data landed.
No spinner, no bar, no reflow - anything that *reflows* is the thing this replaces.
`ResponseViewer` (`modules/request- builder/`) is the pattern's call site; the loading branch there keeps the centred `Loader2` for the case where there is genuinely nothing to hold on to.

**One exception to "nothing moves": `SendingWave`.**
A dim that never moves at all reads as inert rather than as a request in flight - easy to mistake for a stalled send on anything longer than a beat.
`ResponseViewer`'s busy state layers a faint band (`response-wave` in `index.css`, `via-foreground/[0.08]`) that loops across the pane for as long as the send is open, over the dim rather than instead of it.
The opacity is the load-bearing number: low enough that the stale text underneath stays legible through every pass, which is what keeps this from becoming the shimmer this rule is otherwise written against - a shimmer built to stand in for content nobody can see yet is stronger than a band drawn over content that is already fully there.
`pointer-events-none` and `aria-hidden`, since it is a hint over content that is still clickable, not a control of its own, and `aria-busy` on the pane already carries the state for assistive tech.
Confined to `ResponseViewer` - the pane it says something about is the one with the wave.

**Default entity names are Title Case** - the three stored defaults, "New Collection", "New Request" and "New Environment" - even beside sentence-case headings and button labels ("No collections yet", "Delete forever?").
They are stored data, not interface copy: the history views compare a persisted run's `requestName` to `DEFAULT_REQUEST_NAME` by literal, so lower-casing one would make runs already recorded under it read as a name the user chose.
Every other string is sentence case; the rule and its exceptions are in [ux-writing.md](../ux-writing.md#decision-rules).

## Cards

Use `Card` / `CardHeader` / `CardContent` (`app/src/components/ui/card.tsx`), which own the surface, radius, shadow and padding.
A hand-rolled `bg-card border rounded-md` box is drift, not a pattern to copy: `card-primitive.test.ts` fails on any element whose own `className` names a card surface (`bg-card` or `surface-card`), a `border` and an `md`/`lg` radius.
The boxes that wear the surface without being a card - an interactive tile, a row repeated down a list, a joined control, a status strip - are listed in that test's `NOT_A_CARD` with the reason each differs; a new one is added there, not by loosening the rule.
`Card` carries the `bg-card surface-card` pair itself, so a divider inside one writes `border-rule` only; its own outline stays `border`, which faces the canvas.

`Card` names no padding by default, because `CardHeader` and `CardContent` carry their own.
A card that is its own body (a stat tile) takes `pad="sm"` (`p-3`) or `pad="md"` (`p-4`) instead of a hand-typed `p-*`; extras such as `flex flex-col gap-1.5` or `min-w-0` go in `className`.

Never use hardcoded background colors like `bg-gray-50`, `bg-blue-50`, `bg-zinc-900` for card surfaces.
Always `bg-card`.

## Section Eyebrow Label

```tsx
<Eyebrow className="mb-4">Section Title</Eyebrow>
```

The class string behind it (`text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground`) has one home: the `Eyebrow` primitive (`app/src/components/ui/eyebrow.tsx`), which is what a section label should render - it was extracted because the class was hand-typed in about a dozen components and two of them had already drifted.
`Eyebrow` takes `size="xs"` for the denser 10px tier some panes run.

`eyebrow.test.ts` no longer guards only a verbatim copy of that literal: since #1692 it fails on **any** `.tsx` under `app/src` that combines `uppercase` with a `tracking-` utility in one class string, which is the shape every hand-rolled eyebrow had.
Files that genuinely need the combination for something that is not a section label are exempted there by name, with the reason.
The command palette's group headings are an `Eyebrow` inside the element cmdk labels the group by.

## Status Badges / Pills

**Run status pill (`RunStatusPill`, `components/shared`):** the one pill for a run's status, rendered as a `Badge variant="chip"` (it paints its own background) with a glyph and the word - `Running` (spinner), `Completed`, `Stopped`, `Failed`.
The dashboard header draws it for the settled modes and for a streaming run, and nothing for idle; the history run tab's header draws it for every status, `Pending` included (#1944).

```tsx
<RunStatusPill status="failed" />
```

**Status is never colour alone.**
A badge, a chip or a glyph that encodes its state only as a hue says nothing to a red/green confusion, a monochrome display or a greyscale screenshot - and every status surface here is small, where hue is hardest to judge.
The rule is redundancy: **shape or a word carries the state, and the colour agrees with it.**
The pill carries the word and the glyph; the history row carries the shape.

**A verdict refines `Completed`** (#2130): `RunStatusPill` and `RunStatusGlyph` take an optional `outcome` (`run-outcome.ts`) and a `completed` run whose verdict is `failed` or `not-judged` swaps the tick for `CircleAlert` (error family) or `CircleQuestionMark` (neutral, `text-muted-foreground`).
The tick is only for a run that passed; the word stays "Completed".
The dashboard header, the history run tab (a load or collection run's, from its report) and the history row all pass it (#2872, #3543).
The verdict itself is drawn by `RunOutcomeBanner`, a `Callout` whose "Not judged" case is the plain `info` treatment, never the success tick.

**Run status map (`RUN_STATUS`, `components/shared/run-status.ts`):** one entry per status - label, one lucide glyph, the family's `-text` token (the bare token is a fill and fails AA as a small foreground - see "The bare token is the fill") and the pill's tint.
It replaced a bare coloured dot, which was five identical circles in five colours.
**One map feeds the dashboard header's pill, the history run tab's pill and the history row's glyph** (`RunStatusGlyph`), and the Welcome screen's recent-runs word and the collection context bar's last-run word read its label and `-text` token too (through `runStatusDisplay`, with the row's verdict),
and the command palette's run rows word that verdict in their plain-text subtitle, so a status cannot be green in one and neutral in another;
a second status-to-token table in a module is the defect it removed (#1932, a failed run drawn as Completed).

```tsx
const RUN_STATUS = {
  completed: { label: "Completed", icon: CircleCheck, text: "text-status-success-text", tint: "bg-status-success/15 border-status-success/25" },
  failed:    { label: "Failed",    icon: CircleX,     text: "text-status-error-text",   tint: "bg-status-error/15 border-status-error/25" },
  running:   { label: "Running",   icon: Loader2,     text: "text-status-running-text", tint: "bg-status-running/15 border-status-running/25", spin: true },
  stopped:   { label: "Stopped",   icon: CircleSlash, text: "text-status-stopped-text", tint: "bg-status-stopped/15 border-status-stopped/25" },
  pending:   { label: "Pending",   icon: Circle,      text: "text-muted-foreground",    tint: "bg-muted border-border" },
};
```

The glyph is `aria-hidden`: the row's own accessible name states the status in words, so a screen reader hears it once rather than twice.
A glyph that has something no adjacent text says takes `role="img"` **and** an `aria-label` on the same element instead - `role-img-labelled.test.ts` holds that half.
