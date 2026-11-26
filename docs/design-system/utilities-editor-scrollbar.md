---
description: >-
  The Tailwind utility reference and the classes never to use, how the Monaco editor widgets are themed, and the scrollbar rules.
---

# Utility classes, editor widgets and scrollbars

## Tailwind Utility Reference

| Token | Tailwind class |
|-------|---------------|
| Canvas background | `bg-background` |
| Panel background | `bg-panel` |
| Card background | `bg-card` |
| Primary text | `text-foreground` |
| Secondary text | `text-muted-foreground` |
| De-emphasized text | `text-subtle-foreground` |
| Primary accent | `text-primary`, `bg-primary`, `border-primary` |
| Solid accent chip and its hover (text on it) | `bg-primary-tint`, `hover:bg-primary-tint-hover`, with `text-primary-text` on it |
| Default border | `border-border` |
| Strong border | `border-border-strong` |
| Hover state | `hover:bg-accent` |
| Selected state | `bg-accent-active` |
| Success | `text-success-text`, `bg-success/10` |
| Warning | `text-warning-text`, `bg-warning/10` |
| Error | `text-destructive-text`, `bg-destructive/10` |
| Mono font | `font-mono` |
| Thin scrollbar | nothing - 6px is the global baseline (see [Scrollbar](#scrollbar)) |
| Tab-strip scrollbar | `scrollbar-strip` (4px, thumb on hover) - collection detail only; the request and response strips fit-and-overflow |
| Variable color | `text-variable` |

### Never use

- `bg-gray-*`, `bg-zinc-*`, `bg-slate-*` - use `bg-card`, `bg-panel`, `bg-background`
- `bg-blue-50`, `bg-red-950`, etc. - use `bg-destructive/10`, `bg-warning/10`, etc.
- `dark:bg-*` hardcoded overrides - tokens handle both modes automatically
- `text-gray-500`, `text-gray-400` - use `text-muted-foreground`
- Hardcoded hex method colors like `text-[#22c55e]` - use `getMethodColor` or `hsl(var(--method-get))`
- `${hexColor}18` hex-alpha concatenation - use `hsl(var(--method-xxx) / 0.1)`
- Hardcoded purple for Load test / secondary actions - use `text-primary-text`/`border-primary`/`bg-primary-tint`
- `bg-primary/10`, `hover:bg-primary/20` and every other alpha of the accent behind text - use `bg-primary-tint` / `hover:bg-primary-tint-hover` (see [Primary](accent-and-status.md#primary-accent-color))

These rules are enforced by `palette-tokens.test.ts` (under `modules/request-builder/components/ResponseViewer/`) over every `.tsx` in `modules/` and `components/` (#1693).
They were documented long before they were enforced, and the tree had drifted: seven usages of `text-green-500` / `text-blue-500` and friends, every one of which failed its contrast bar in **light** mode (1.63–3.76 against thresholds of 3.0 and 4.5) while passing in dark.
That asymmetry is inherent to a raw palette class rather than bad luck - one value cannot suit a white card and a near-black one, so the light failure is unfixable without breaking dark.
The per-theme `-text` tokens clear both.

The guard's scope and its two exemptions are described under "Decorative categorical palettes", above.

---

## Monaco Editor Widgets

`CodeEditor` does not hand Monaco its built-in theme names (`vs` / `vs-dark`): every widget Monaco draws around the text - the suggest list, the find and replace widget, the hover card, the context menu - would paint VS Code's palette next to the app's Radix popovers and tokens.
`lib/monaco-theme.ts` defines `vayu-light` and `vayu-dark` through `monaco.editor.defineTheme`: each inherits the built-in theme's syntax colours and replaces only the chrome, so a token change reaches the editor the same way it reaches every other surface.
`WIDGET_COLORS` in that file is the mapping below; a key it does not name keeps whatever the base theme says, which is correct for anything the tokens have no opinion about (bracket-pair colours, the diff editor).

**The editor canvas itself**, so it reads as the app's surface rather than Monaco's own near-black default in dark mode:

| Monaco colour key | Token |
|---|---|
| `editor.background`, `editorGutter.background` | `background` |
| `editor.foreground`, `editorLineNumber.activeForeground`, `editorCursor.foreground` | `foreground` |
| `editorLineNumber.foreground` | `muted-foreground` |

**Selection and find matches**, painted on Monaco's own canvas rather than as DOM the app's CSS could reach:

| Monaco colour key | Token |
|---|---|
| `editor.selectionBackground`, `editor.inactiveSelectionBackground`, `editor.selectionHighlightBackground` | `primary` |
| `editor.findMatchBackground`, `editor.findMatchHighlightBackground` | `primary` |

**The floating surfaces** - the suggest widget, the hover card, the context menu, and the generic editor widget - take the same three roles a Radix popover uses:

| Monaco colour key | Token |
|---|---|
| `focusBorder` | `primary` |
| `editorWidget.background`, `editorSuggestWidget.background`, `editorHoverWidget.background`, `menu.background` | `popover` |
| `editorWidget.foreground`, `editorSuggestWidget.foreground`, `editorHoverWidget.foreground`, `menu.foreground` | `popover-foreground` |
| `editorWidget.border`, `editorSuggestWidget.border`, `editorHoverWidget.border`, `menu.border` | `border` |

**The rows inside them** - the suggest list and the context menu are both Monaco lists:

| Monaco colour key | Token |
|---|---|
| `editorSuggestWidget.selectedBackground`, `list.hoverBackground`, `list.focusBackground`, `menu.selectionBackground` | `accent` |
| `editorSuggestWidget.selectedForeground`, `list.hoverForeground`, `list.focusForeground`, `menu.selectionForeground` | `accent-foreground` |
| `editorSuggestWidget.highlightForeground`, `editorSuggestWidget.focusHighlightForeground`, `list.highlightForeground` | `primary` |

**The find widget's input**, a plain box in VS Code's palette:

| Monaco colour key | Token |
|---|---|
| `input.background` | `background` |
| `input.foreground` | `foreground` |
| `input.border` | `border` |
| `inputOption.activeBorder` | `primary` |

**The scrollbar slider** carries the same two alphas as `::-webkit-scrollbar-thumb`'s rest and hover states (see [Scrollbar](#scrollbar)), plus a third for the pressed state Monaco has and the native bar does not:

| Monaco colour key | Token |
|---|---|
| `scrollbarSlider.background` | `muted-foreground` |
| `scrollbarSlider.hoverBackground` | `muted-foreground` |
| `scrollbarSlider.activeBackground` | `muted-foreground` |

Two constraints follow from how the theme is built.
**Only the mode the document is currently wearing can be defined** - `getComputedStyle` reports the live values, so the light palette is unreadable while `.dark` is on `<html>`, and the reverse.
And **the theme is registered during Monaco's composition, before any editor is created, and redefined from a `MutationObserver` on `<html>`'s `class` and `data-color-scheme`, never from a React effect** - a child's effects run before its parent's, `<Editor>` is the child, and Monaco answers a theme name it does not know by silently falling back to `vs` and never revisiting it.
Redefining the theme that is currently showing is what lets a colour-scheme change reach an open editor without a reload.

`IStandaloneThemeData` has no key for font or corner radius, so those two still live in `index.css`, scoped under `.monaco-editor` - and, unlike every other rule in that file, **outside `@layer` and prefixed with `html`**.
Monaco ships unlayered CSS that declares both properties on the same two-class selectors, and an unlayered declaration beats a layered one at any specificity, so the same rule inside `@layer utilities` never applies at all; unlayered it merely ties, and Monaco's stylesheet arrives after this one with the lazily loaded editor chunk.
Any future rule that has to win against a widget Monaco styles itself needs both halves.
`monaco-theme.test.ts` reads them back out of the stylesheet and fails if either is dropped.

Guarded by `lib/monaco-theme.test.ts` (the builder, plus a source scan that no file outside the theme module passes `"vs"` / `"vs-dark"`), `components/ui/code-editor.theme.test.tsx`, and the sixth concern in `lib/monaco-setup.contributions.test.ts`.

---

## Scrollbar

**Thin scrollbars are a global baseline, not a utility.**
Every scroll container gets them; there is nothing to remember and nothing to apply.

```css
/* index.css, @layer base */
@supports not selector(::-webkit-scrollbar) {
	:where(*) {
		scrollbar-width: thin;
		scrollbar-color: hsl(var(--muted-foreground) / 0.3) transparent;
	}
}
:where(.overflow-auto, .overflow-y-auto, .overflow-scroll, .overflow-y-scroll) {
	scrollbar-gutter: stable;
}
::-webkit-scrollbar {
	@apply w-1.5 h-1.5;
}
```

**The `@supports` guard is load-bearing, not defensive.**
Since Chromium 121 a scroller that declares `scrollbar-width` or `scrollbar-color` renders the _standard_ scrollbar and ignores every `::-webkit-scrollbar` rule that applies to it - the two systems do not compose.
The properties were declared globally on `:where(*)`, so the whole webkit block below them was inert: the stylesheet said 8px and the app drew Chromium's `thin`, which measures 10px.
That gap is the "scrollbars read too thick" report.
Measured on Chromium 141: a scroller with `scrollbar-width: thin` and a 6px `::-webkit-scrollbar` renders **10px**; the same scroller with the standard properties behind the guard renders **6px**.

So `scrollbar-width` and `scrollbar-color` belong nowhere outside that guard.
Setting either on an element turns that element's webkit rules off, silently - the bar stays, at the wrong width, in the wrong colour.

**6px, and 6px in all three systems.**
The app draws scrollbars three ways, and only the first is reached by a stylesheet at all:

| System | Where the width lives | Was |
| ------ | --------------------- | --- |
| Native `overflow` panes | `index.css`, the block above | 8px declared, 10px drawn |
| Radix `ScrollArea` | `scroll-area.tsx` class list | 10px, `bg-border` thumb |
| Monaco editors | `code-editor.tsx`, `SCROLLBAR_SIZE` in px | 14px vertical, 12px horizontal |

They are read side by side - a body panel puts an editor, a `ScrollArea` and a plain scroll pane in one view - so all three carry one number.
`ScrollArea` also repeats the baseline's `muted-foreground/30` thumb: `--border`, shadcn's default, is the same colour as `--card` in dark, which is an invisible thumb on the surface that component is usually laid over.
Monaco renders its bars as its own DOM inside the editor and takes a **number**, not a class, which is why no sweep of the stylesheet can see it drift.

`scrollbar-systems.test.ts` derives the two repeats from the CSS, so the three move together or the suite reddens.

Do not take a content pane below 6px: the thumb stops being a mouse target.

The baseline also reserves a 6px gutter with `scrollbar-gutter: stable` on scroll containers (via Tailwind utility classes), placed outside the `@supports` guard because this property does not trigger the standard-property opt-out that affects width and color.
Per CSS Overflow 4, the gutter reserves for `overflow: hidden` too, so it is scoped via CSS class selectors rather than applying globally - `overflow-hidden` is used throughout the app for text truncation and clipping, and deserves no dead 6px strip.

Surfaces where a permanent 6px reserve reads as a dead band opt out with `[scrollbar-gutter:auto]` (arbitrary property, so it beats the zero-specificity baseline): the floating menus (`dropdown-menu`, `select`, `context-menu`, `command` list, the tab overflow menu), the dialog panel and body, and the markdown editor's textarea and preview.
They only scroll rarely and would otherwise show an empty strip inside a padded surface; the trade-off is that their content shifts by the scrollbar width on the occasions they do overflow.
Sidebar lists (history, trash) keep the reserve and no longer add their own `pr-1`.

### Tab strips: `scrollbar-strip`

**The request builder's and the response viewer's strips do not scroll** (#2200).
They were `overflow-x-auto` with this bar hidden, so at the default split (~430px a pane) the last tabs were cut off with nothing to say they existed.
Each now measures the room it has (`useFittedTabs`, the canvas-measured fit `TabStrip` uses for document tabs), draws the triggers that fit in an `overflow-hidden` list and sends the rest to a `+N` menu (`TabOverflowMenu`) that sits beside the `TabsList`, never inside it.
The active tab is always drawn, and each tab's width budgets the mark (count, dot, result chip) it may grow, because marks animate in after the fit.
The measured element is a wrapper that fills the row, not the list, which shrinks to what it draws.

A hidden tab's mark follows its label in the menu item, and a hidden tab that holds a failure (a script error, a failing test run) puts a `TabErrorDot` on the `+N` trigger and says so in its `aria-label`: the menu is closed, so an item's own mark would otherwise be the only place the failure showed.

A `TabsList` that scrolls natively (collection detail) draws the baseline bar directly under a 24px band of tabs.
The scoped utility takes that strip to 4px and hides the thumb until the strip is hovered:

```css
/* index.css, @layer utilities */
.scrollbar-strip::-webkit-scrollbar {
	@apply w-1 h-1;
}
.scrollbar-strip::-webkit-scrollbar-thumb {
	@apply bg-transparent;
}
.scrollbar-strip:hover::-webkit-scrollbar-thumb {
	@apply bg-muted-foreground/30;
}
```

Chromium repaints scrollbar pseudo-elements on the scroller's own `:hover`, so the reveal costs no JS.
This is the one blessed exception to the 6px floor: a strip is scrolled by wheel or by tab focus rather than dragged.

This was a `.scrollbar-thin` class applied per element, and it drifted badly: **38 of the app's 44 scroll containers never got it**, so chunky arrow-button scrollbars appeared mid-UI.
Two traps made the class approach unfixable by discipline alone:

- **`scrollbar-width` is not inherited.**
  A styled ancestor does nothing for a nested scroll container.
  This is exactly how the History run list ended up with a platform scrollbar inside an already-styled panel.
- **Styling `::-webkit-scrollbar` at all is what removes the stepper arrows.**
  So an unstyled container did not merely look slightly different - it grew arrow buttons, which is a different control, not a different colour.

`:where()` keeps specificity at zero, so an element that genuinely needs a different scrollbar can still override with a plain class.

Electron is Chromium, so the webkit rules are the ones that render here; `scrollbar-width` is the standards-track fallback for an engine that has no such pseudo-element, which is why it sits behind the `@supports` guard above rather than beside the rules it would otherwise disable.
