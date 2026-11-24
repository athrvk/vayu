---
description: >-
  The keyboard focus ring baseline, the hover transition and the interaction states every control follows.
---

# Focus & Interaction States

Interactive elements get a keyboard focus ring and hover transition from a baseline in `app/src/index.css` (`@layer base`) - **do not add per-component focus classes for the default case.**

```css
:where(button, [role="button"], a[href], input, select, textarea, summary,
       [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 1px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

- `:where()` keeps specificity at **0**, so any component utility overrides it without `!important`.
  The `components/ui/*` primitives already carry their own `focus-visible:ring` and keep their appearance.
- `:focus-visible` fires only on keyboard/AT focus - mouse users never see a ring.
- **1px, not 2px.**
  On dense lists and toolbars a hairline reads as considered; a 2px saturated rectangle reads as a browser default.
- `outline` follows the **element's own** `border-radius`.
  That means the roundedness setting governs the ring **only on elements that already carry a `rounded-*` class**.
  An element with no radius gets a square ring at every setting - so if a ring should reshape with the control, put the indicator on an element that has the radius (see below).
- Transitions list paint properties explicitly (`background-color`, `color`, `border-color`, `opacity`) at **150ms**.
  Never `transition: all` - it can animate layout properties.
  Reduced motion already collapses these app-wide.

**Clipping panels.**
An element whose `overflow-*` would cut off an outset ring must carry `.panel-clip`; every focusable descendant then gets `outline-offset: -1px`.
Currently on the `TabStrip` row, the `Drawer` content wrapper and the bordered cards in the load-test and run-collection dialogs; `rg panel-clip app/src` is the authoritative list.
Put it on the element carrying the overflow - not on the rows.
For a one-off outside such a container, use `focus-visible:-outline-offset-2`.

Two limits worth knowing before reaching for it.
**`overflow-y-auto` clips horizontally too** - it computes `overflow-x` to `auto`, so a box that only meant to scroll vertically still cuts a ring off its left and right edges.
And **`.panel-clip`'s element list is narrower than the baseline's**: it covers `button`, `[role="button"]` and `[tabindex]` only, so for `a[href]`, `input`, `select`, `textarea` and `summary` it is inert - the baseline still draws the ring 2px out and the panel still cuts it off.
The `components/ui` primitives are unaffected either way, since they set `focus-visible:outline-none` and paint their own ring.

`DialogBody` carries its own clearance for exactly this (issue #1627): a field inside a dialog needs nothing.

**Which is why a primitive fixes its own clipping, with `ring-inset`.**
Neither `.panel-clip` nor an `outline-offset` utility reaches a Tailwind `ring` - both move `outline-offset`, and a primitive has already turned its outline off.
`TabsTrigger` is the worked example: a trigger fills its list's height exactly (measured in the running app, both boxes were 74->98) and the three scrolling strips - the response viewer, the request builder and Collection Detail - are `overflow-x-auto overflow-y-hidden`, so an outward `ring-2` had no room at the top or bottom and rendered as two cut-off vertical strokes.
`focus-visible:ring-inset` on the trigger fixes every strip at once, present and future; padding the three lists would have fixed it three times.
Same reasoning as *prefer clearance* above, reached the other way round: the clipping is on the list and the ring is on the trigger, and only one of those is a single place.
Guarded by `tabs.test.tsx`.

**Prefer clearance to tucking-in for a control that also appears outside a clipping panel.**
Both fix the clipping; only clearance keeps one control looking like one control.
The row-enable checkbox is the worked example: a plain `<input type="checkbox">` in both the variables table and the request builder's key-value rows.
`KeyValueRow` wraps its row in `p-1`, so the ring reads as an outset hairline with a 4px gap.
The variables table's cell had no horizontal padding and sat against a `p-0` scroll container, so the ring lost its left side on Collection Detail but not on the Variables screen, where the container carries `p-4`.
The fix is `px-1` on that cell - the same 4px - **not** `.panel-clip` on the container, which would have tucked this instance's ring inward and made the two checkboxes disagree.
`key-value-parity.test.tsx` guards both halves: the two checkboxes must declare equal clearance, and neither may sit under a `.panel-clip`.
The clearance assertion alone would pass a change that re-broke the match.
That file grew into the wider parity contract between the two tables (#587) - control height, checkbox sizing and accent, the destructive row-action variant, and the shared secret-reveal control.

**Composite rows - `.focus-row`.**
The baseline attaches the ring to whatever is *focusable*, which is only right when the focusable element is also what the user reads as the target.
In a tree row it often isn't: a collection row is 220px with a rounded hover fill, but its label button is 150px with square corners, so an outline on the button indicates the wrong shape in the wrong place.

Put `.focus-row` on the element that paints the hover background.
It then draws the indicator itself - at its own radius, so the roundedness control governs it.
The inner control draws nothing.

```css
:where(.focus-row):has(:focus-visible:not(.focus-self)) {
  outline: 2px solid hsl(var(--ring));
  outline-offset: -2px;
}
.focus-row :focus-visible:not(.focus-self) { outline: none; }
```

The indicator is the full `--ring`, the same as the disclosure chevron's own ring (`ring-2 ring-ring`).
A focus indicator is a UI component boundary and owes WCAG 1.4.11's 3:1; `--primary` at 30% composited onto a row measured 1.42-1.61 in light and 1.56-2.00 in dark across the schemes, so it was a tint, not an indicator.
`focus-ring-contrast.test.ts` holds the ring at 3:1 on card, panel and canvas for every scheme in both themes.
The selected-row ring (`ring-1 ring-inset ring-primary/20`) stays a tint: it marks selection beside a fill and is not a focus indicator.
The focus indicator uses `outline` rather than `box-shadow` because Tailwind's ring utilities own `box-shadow` - a selected row already sets one, which would override it.

**Auxiliary controls opt out with `.focus-self`.**
A control inside the row that is its own target - the chevron toggles expansion rather than opening the collection - keeps its own ring and does not light the row, so exactly one indicator ever shows.

`.focus-row` covers two cases: the row is itself focusable (the collection tree's roving tabindex focuses the row), or focus sits on a control inside it.
`:has()` is descendant-only and does not cover the first, hence the `:focus-visible` selector alongside it.

**Focus must be able to leave, and a Monaco editor is where it could not.**
A ring that says where focus is means nothing if Tab cannot move it on.
Monaco indents with Tab - right for a code editor, and a keyboard trap for anyone who reached one by tabbing (WCAG 2.1.2).
Two rules, both held in `ui/code-editor.tsx` rather than at the dozen mount sites:

- **A read-only editor runs with `tabFocusMode` on.**
  There is no indentation to insert in text nobody can type into, so Tab simply moves focus and no trap exists to escape.
- **An editable editor advertises the way out while it holds focus.** ⇧⌘M (`LEAVE_EDITOR_CHORD`) moves focus to the first focusable element after the editor, and a `Kbd` hint names it in the editor's bottom-right corner - on focus, not always, so a dozen panes do not each carry a standing badge over their content.
  The caps come from `chordKeys`, like every other chord this app puts on screen; a hand-rolled badge would be a second place a modifier is spelled.

The general rule behind both: **any component that takes over a key the browser uses for navigation owes the user a documented way back**, and that way back is a `Chord` in `constants/shortcuts.ts` so the Keyboard Shortcuts panel lists it without being told.
Guarded by `code-editor.chords.test.tsx` (the chord is registered, the hint appears on focus and never on a read-only editor) and `shortcuts.listed.test.ts` (it reaches the panel).

**Moving focus *between* regions is F6's job, not Tab's** (#1219).
The window is eight bands - the title bar, the activity rail, the drawer, the main pane, the context bar, the context rail, the bottom panel (#3635, while it is open) and the Dock - and reaching one from another by Tab alone meant walking every request in an expanded collection tree on the way.
F6 cycles the bands in that order (document order); Shift+F6 goes back.
The two rails joined with #1615 and #3498 because each stays on screen while the panel it opens is closed, and the Dock with #3498 because its save status and per-tab view controls were otherwise the last thing Tab reaches.
**The tab strip is deliberately not a band**: it is the main pane's header, one roving tab stop directly above `main`, so Shift+Tab from the pane's first control reaches it and its own chords (⇧⌘[ / ⇧⌘], ⌘1-9) switch tabs from anywhere; a stop of its own would put a second press between every band and the pane F6 is pressed for most.
F8 is the neighbouring key and is not the app's: Radix's `ToastProvider` binds it to the notification stack, which is the only keyboard path to a toast's Undo.
It is listed in the Keyboard shortcuts panel as a display-only chord (`FOCUS_NOTIFICATIONS_CHORD`), and `Toaster.test.tsx` holds it equal to the key Radix names in the viewport's accessible name.

Each band carries `data-app-region` rather than being found by landmark tag.
`header, aside, main` looks like it would do the same job, and it does not: the run view renders its own `<header>`, the breadcrumb its own `<nav>`, and the inbox its own `<aside>` - content landmarks *inside* `main`, so a tag query would cycle around inside one region forever rather than moving between the seven the window actually has.
The attribute says which of the shell's children are stops in the cycle, and a feature adding a landmark of its own cannot join it by accident.

A band is marked by spreading `regionProps("drawer")` from `region-focus.ts`, never by writing the attribute onto the element.
A JSX attribute *name* has to be a literal, so bands that spelled it out left one name with five spellings, four of which a rename would leave behind; and the value they carried inline, `{"drawer" satisfies AppRegion}`, is a node `jsx-ast-utils` has no case for, so `pnpm lint` printed two "could not be resolved" advisories on every run, CI included (#1261).
The helper takes the `AppRegion` union, which makes a name that is not a band an error at the call rather than on the value.

Focus lands on the region's first focusable element, never on the region container itself.
A `tabindex="-1"` box would be a legal target and would take focus silently: the `:focus-visible` rule above is written `[tabindex]:not([tabindex="-1"])`, on purpose, so a script-focused container paints no ring at all.
Landing there would move focus with nothing on screen saying where it went, which for a keyboard-only feature defeats the point of the key.

**A `{{variable}}` inside an editor is painted from the same tokens as one outside it.**
`EditableVariable` colours its overlay tokens `text-primary-text` / `text-muted-foreground` / `text-destructive-text` for resolved, empty and undefined, and gives undefined a wavy underline as well;
Monaco draws its own text, so the same three states (plus `text-muted-foreground` for a run-time token, `text-warning-text` with a double underline for a `data.*` column no contract declares, and `text-muted-foreground` with a dashed underline for a name a pre-request script sets, #2741) are declared in `index.css` as six global classes its decorations can name -
`vayu-variable-token-*`, under a `.monaco-editor` prefix so they outrank the theme rules Monaco injects at runtime.
They are the one place a global class is the right answer rather than a utility string, for the same reason the scrollbar block is: no component stylesheet reaches what Monaco renders.
A time in an editor (issue #1786) is the seventh, `vayu-time-token`: a dotted underline in `--muted-foreground` rather than a colour, so the language's own token colour still reads under it.

**No variable state rests on a colour difference under 0.10 OKLab** (#3499).
The accent is one of the colours, so a scheme can land it on a neighbour: coral's and sunset's accents sit under 0.10 from `--destructive-text`, light sunset's `--primary-text` 0.068 from `--warning-text`, and graphite's and light sky's `--primary` that close to `--muted-foreground`.
The undefined state therefore carries a non-colour cue, a **wavy** underline, and the undeclared `data.*` column a **double** one (one style, one meaning: dashed is deferred, dotted is a time).
The resolved state paints `--primary-text`, which graphite and light sky retune away from the grey.
`color-scheme-contrast.test.ts` measures every pair of the five states in every scheme and theme from the Monaco classes, `EditableVariable.test.tsx` holds the field painter equal to them, and `variable-token-classes.test.ts` does the same for `DATA_TOKEN_TONE_CLASS`, the painter of the warning state in the overlay and the script panel's chips. → `variable-token-classes.test.ts`
