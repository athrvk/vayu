---
description: >-
  The accessibility rules, and the list of `jsx-a11y` suppressions that a guard holds to the sources.
---

# Accessibility

Which tool holds a rule decides what breaking it looks like: a lint error on the line, a source scan naming the file, a rendered assertion, or - for a rule no tool holds - nothing at all.
`eslint-plugin-jsx-a11y`'s recommended set now runs on every `.tsx` under `pnpm lint`, underneath the behavioural guards rather than instead of them: the lint reads markup, and none of the rules below are things it can see.

| Rule | Enforced by |
|------|-------------|
| An icon-only button carries an `aria-label`, no native `title`, and shows its label on focus (`TooltipIconButton`, or a `Tooltip` written by hand and listed in the guard) | `icon-button-labels.test.tsx`, the `*.tooltips.test.tsx` beside each row button |
| `outline-none` is paired with a replacement indicator | `focus-indicator.test.ts` |
| A control revealed on hover is revealed on focus too | `row-action-reveal.test.ts` |
| An editor that takes Tab advertises the way out | `code-editor.chords.test.tsx` |
| Every chord the app listens for is listed for the user | `shortcuts.listed.test.ts` |
| A hand-rolled `role="button"` is focusable and answers Enter/Space | `jsx-a11y/interactive-supports-focus`, `jsx-a11y/click-events-have-key-events` |
| A `role="treeitem"` carries `aria-selected` | `jsx-a11y/role-has-required-aria-props` |
| A `<label>` names a control | `jsx-a11y/label-has-associated-control`; `LabelledField` links a prop-driven label by `useId` (`AuthFields.test.tsx`, `OAuth2Form.names.test.tsx`) |
| A control with no visible label of its own (a standalone select, an inline rename field, a popover dialog, an icon-only table header) is named by `aria-label` or `sr-only` text | the covering test per site, e.g. `AuthPanel.test.tsx`, `CollectionTree.rename.test.tsx`, `VariableTableEditor.banner.test.tsx` |
| A tree row's accessible name is its own name: `aria-labelledby` on the `role="treeitem"` points at the name element (the method badge first for a request), omitted while the name is a rename field | `CollectionTree.a11y.test.tsx`, `VariablesCategoryTree.keyboard.test.tsx` |
| Every region of the window but the tab strip (the main pane's own header, by design) is a stop in the F6 cycle | `region-focus.test.ts`, `region-focus.markers.test.ts` |
| A tab's main pane has one `h1`, and no heading under it skips a level | `heading-outline.testkit.tsx`'s `expectOneTopHeading`, one case per tab root... [Details](#one-top-heading-per-tab-in-full) |
| Every `role="img"` carries an `aria-label` on the same element; a chart is one (`UPlotChart`'s required `ariaLabel`) | `role-img-labelled.test.ts`, `UPlotChart.test.tsx`, `chartLabel.test.ts` |
| A run's start and ending are announced, wherever focus is | `RunAnnouncer.test.tsx`, `shell-tab-identity.test.tsx` |
| A bar that measures progress is the `Progress` primitive, named | `ProgressCard.test.tsx` |
| An element that renders text never paints a translucent accent (`bg-primary/<n>`, `bg-status-<name>-fill/<n>`) behind it; the opaque `--primary-tint` family is held to 4.5:1 per scheme instead | `accent-alpha-under-text.test.ts`, `color-scheme-contrast.test.ts` |
| A `jsx-a11y` suppression carries a reason and is listed below | `a11y-suppressions.test.ts` |

**A tree row is named by its name, not by what is inside it.**
A `treeitem` with no name of its own is named from its content, and Chromium reads every descendant into that: the chevron's "Collapse collection", the count, the `⋯` menu trigger's label (#3450).
The row therefore takes `aria-labelledby` naming the name element (`TruncatedText` and `MethodBadge` forward an `id` for it), with the method badge first on a request so the row reads "GET Get invoices".
While the row renames, the name element is the field and has no text to point at, so the attribute is omitted.
The variables tree builds its ids from one `useId` plus the row's id, since its rows are drawn in a loop.

**An operation that takes seconds announces its progress.**
A dialog that sits on a spinner and a bar reports nothing to a screen reader: the bar's value is read on demand, never pushed.
Every multi-second operation therefore puts `role="status" aria-live="polite"` on **the visible line that says what is happening** - not an off-screen copy, which is a second string to keep in step with the first.
The import dialog (`ImportProgressView`), the export dialog and the collection tree's busy states all do.

The counterpart rule is what stays out of the region: a polite region re-announces on every text change, so a figure that moves several times a second (`ImportProgressView`'s byte counter) is marked `aria-hidden` inside it and left for the eye.
A counter that moves once per file is slow enough to keep.

**A run is the one operation announced from an off-screen region.**
`RunAnnouncer` (`components/layout/`) is an `sr-only` polite region that `Shell` mounts once, outside the tab panel, and it is a deliberate exception to the visible-line rule above for two reasons.
A run is long enough that the user is often on another tab when it ends, and only the active tab's surface is mounted, so a region on the dashboard or the run view would not be in the DOM to hear it; and the visible lines it would sit on (the status pill, the verdict banner) are replaced or remount when the run settles, which a live region does not survive.
It speaks transitions only, never a figure the run moves: a load test or collection run starting, then how it ended - "Load test completed.
Passed.
All 3 budgets met", "Load test stopped", "Load test failed. <reason>", "Collection run completed. 41 passed, 2 failed" - with the verdict taken from `reportOutcome`, the banner's own, so the two cannot disagree.
A collection run that missed a budget says so after its counts ("Collection run failed. 12 passed, 0 failed. 1 of 2 budgets missed: p99", #3539), so its ending waits for the stored report, the only place the budgets are; one that cannot be read is still announced, with the counts alone.
A load test the engine's process ended under is announced once, as "Load test ended.
Vayu's engine stopped" (#3605), and its ending is announced again when the restarted engine's stored report lands; a collection run's is announced the same way, as "Collection run ended.
Vayu's engine stopped" (#3621), once, never over an ending already heard, and a later ending still speaks.
A lost stream and the wait for the report are not announced.
The run's progress bar is the `Progress` primitive ("Run progress"), read on demand; the hero row's fidelity gauges (`MiniBar`) are `aria-hidden`, since the percentage above each states the same value in words.

**A `role="img"` is a promise that the element has something to say.**
A decorative glyph given the role and no label announces as an unlabelled image; a labelled one beside text that already says the same thing announces twice.
`jsx-a11y` can see neither case.
The mechanical half - the label - is `role-img-labelled.test.ts`; the other half is a judgement made at the site, and the run row's status glyph is where it landed on `aria-hidden` (see Status Badges).

**A chart is an image with a sentence for a name** (#3498).
`UPlotChart` draws on a canvas, which has no DOM for a screen reader to walk, so its host is `role="img"` and `ariaLabel` is a required prop: no mount site can omit it.
The semantic wrappers build the label with `describeChart(title, data, series)` (`charts/uplot/chartLabel.ts`): the title, then per series the latest, lowest and highest reading, spelt by the series' own `format` so the sentence reads what the hover tooltip reads ("2.27ms", not a second set of digits), with a `<0.01` spoken as "less than 0.01".
A series the tooltip hides is left out and a stacked one reads its own values, not its running total.
A chart whose "latest" would mislead writes its own sentence (the HDR distribution names its percentiles) and one with a better one passes it in (`RunTrend` says how many runs and the newest figure).
An image's children are hidden from assistive technology, so a legend (`ChartLegend`) sits beside the host, never inside it.

**A tab has one top heading, and a heading's level is where it is drawn** (#3498).
Heading navigation is how a screen-reader user skims a pane, so each tab's main pane has exactly one `h1` naming it and nothing below it skips a level (axe's `heading-order`).
The `h1` is the title the tab already shows: the run's name in History, the category in Settings, the collection's name, the scope in Variables, the inbox's or mock's address (with a hidden prefix saying what it is the address of), and on the request builder and the dashboard, which draw no other title, the crumb's current segment (`TabBreadcrumb`'s `titlesPane`).
The welcome tab's populated Launcher has no title to draw, so its `h1` is an `sr-only` "Vayu", the tab's name and the first-run screen's visible one.

Below the `h1`, a level is not something a component can know: the run report's summary cards sit under the run's title in History and under the report's crumb on the dashboard, and an empty state is a whole tab in one place and a card's body in another.
So the title primitives draw `Heading` (`components/ui/heading.tsx`), which takes its element from a context (`heading-level.ts`):
the Shell opens the outline at 1 around the active tab, whatever draws a tab's `h1` wraps the rest in a `HeadingSection`, and `CardTitle`, `EmptyState` / `ErrorState`'s pane title and the headings of a component more than one surface renders (the response pane's sections, the headers viewer) render at that level.
A card does not open a section.
A dialog opens its own at 3 under its `h2` title, because context crosses the portal.
Outside the outline (the drawer, the context bar) a card title is an `h3` and an empty state's title a paragraph; `CardTitle`'s `as` pins the element for the one card that is its own page, the crash screen's `h1`.
A heading a tab root draws for itself is written as the literal element.

**A tooltip is not a name.**
Radix supplies `aria-describedby` while a tooltip is open, which is a description; before it opens - and to a screen reader reading the row - the button is announced as "button".
The Dock's four view switchers all had tooltips and all announced as bare buttons.
The converse holds too: a native `title` is a tooltip for a pointer only, since it does not surface on keyboard focus or touch, so an icon-only button takes `TooltipIconButton` (`aria-label` and the app's `Tooltip` from one `label`; `tooltip` when the text should be the verb alone while the name carries the row, "Restore Login" named, "Restore" shown) and carries no `title` at all.
The guard pins icon-only buttons with a `title=` at zero, and pins the plain `<Button size="icon">` that remain to the files that wrap them in a `Tooltip` by hand (a tree header's trigger, a ref-taking child a wrapper cannot forward to), so a new bare one fails.
A menu trigger is one of those: the row `⋯` menu (`RowActionsMenu`) shows "More actions" on focus but not on the focus its closing menu hands back, which would otherwise cover the row the user just acted on after every Escape.
A row's hover-revealed Delete is the same: revealed on focus (`row-action-reveal.test.ts`) and labelled on focus (`TooltipIconButton`).
A text button whose tooltip adds an explanation wraps `Button` in `Tooltip` the same way, and a disabled one gives its reason through `DisabledHint`, because `Button` is `pointer-events-none` while disabled and neither a `title` nor a bare `Tooltip` can reach it.

**`outline-none` needs its replacement in the same class string.**
The base `:focus-visible` outline at the top of this page is the whole focus story for anything without its own ring, so `outline-none` is the single token that opts an element out of it - and the command palette's input had been opted out since it was written, unnoticed, because it is the only focusable element in its dialog.
A replacement may be a ring on the element, a ring on the wrapper it fills (`focus-within:`, as `CommandInput` and `VariableInput` do), or the background fill Radix and cmdk paint on `data-[selected]` / `data-[highlighted]`.
An element that is genuinely never a tab stop is exempt by name, with a reason, in the guard - and an exemption claiming "the wrapper paints it" has to name the class that does.

**A composite widget is not itself a tab stop.**
A tree, a tablist or a radiogroup keeps one focusable descendant and moves that stop with the arrow keys (`useRovingTreeFocus.ts`); the container carries the `onKeyDown` and no `tabIndex`.
`jsx-a11y` cannot see across that split and reports the container as unfocusable, so those sites carry a one-line disable naming the hook - the same for a row whose Enter and Space arrive through the tree rather than through its own handler.

**A radio group built from `ToggleGroup` needs no disable at all.**
The variable popover's "create in" row was the hand-rolled kind - a `role="radiogroup"` div whose arrow handler sat on each `role="radio"` button, where the keydown starts, rather than on the container it would bubble to, which is what kept `interactive-supports-focus` quiet (issue #1380).
It is the primitive now (issue #1391), so Radix owns the roles, the tab stop and the arrows, and the rule has nothing to inspect: `jsx-a11y` reads JSX elements, and a component is not the bare `<div role="radiogroup">` it reports on.
Reach for a hand-rolled group only where `ToggleGroup` does not fit, put the handler on the options while they are focusable in their own right, and take the disable with the container handler when they are not.
Selection is a modifier there, not a destination: it follows focus, so the arrows move both together between the segments, and a mouse click on one returns focus to the value field it qualifies, because a segment that keeps focus after a click leaves the next keystroke going nowhere.

**The lint's allowlist.**
Three rules are configured rather than obeyed as written, in `app/eslint.config.mjs`, each because the pattern it flags is the correct one here:

- `no-autofocus` is off.
  Its 14 sites are all a field inside a dialog, a rename box opened over a row, or the command palette - moving focus into what the user just opened is the WAI-ARIA dialog pattern, not the page-load autofocus the rule exists to prevent.
- `label-has-associated-control` is given `labelComponents: ["Label"]` and `controlComponents: ["Switch", "Input", "SelectTrigger", "Checkbox"]`.
  The rule reads a lower-case `<label>` and a lower-case control by default, so without `labelComponents` an unlinked `<Label>` - the primitive every form uses - was never checked (#3498).
  The control list names what renders exactly one native labelable element, so a `<Label>` wrapping one is already associated.
  The rule cannot see a label whose text is an expression (`<Label>{label}</Label>`), which is every helper that renders its label from a prop; `LabelledField` is the one such helper, and `AuthFields.test.tsx` / `OAuth2Form.names.test.tsx` are what hold it.
  A caption over a group of controls (a `ToggleGroup`, a row list) is not a `<label>` at all: it is a `<span>`, and the group names itself.
- `no-noninteractive-tabindex` also allows `role="separator"`.
  A focusable separator is the ARIA window splitter, which is what both resize handles are, arrow/Page/Home/End and all.

Everything else is suppressed at the line it happens on, with the reason and the file that provides the missing half.
**22 directives across 17 files**, listed here because a rule-level configuration is visible in one place and a line-level one is visible only to whoever opens that file - and because nothing otherwise stops the count growing one justified line at a time.
`a11y-suppressions.test.ts` reads this list and the sources together: a site added, moved or removed without the list following fails, an unreasoned directive fails, and the count is a ceiling that comes down when a suppression goes rather than a budget to spend.

Paths are relative to `app/src`, and the count in brackets is directive lines, not rule names - two of these lines silence two rules at once.

- `components/layout/TabStrip.tsx` (1) - `jsx-a11y/interactive-supports-focus` on the tablist, whose tab stop is the active tab.
- `components/layout/TabItem.tsx` (1) - `jsx-a11y/click-events-have-key-events` on the close affordance, which is Delete or Backspace on the focused row and a `tabIndex={-1}` pointer target here (the row moved out of `TabStrip.tsx` with #1714).
- `components/layout/ActivityRail.tsx` (1) - `jsx-a11y/no-noninteractive-element-interactions` on the `<nav>`: roving `tabindex` for Up/Down between the six view buttons, the same shape `TabStrip`'s tablist uses for Left/Right, on a landmark rather than a widget role because the rail is deliberately `role="toolbar"`-free (#1615).
- `components/layout/ContextRail.tsx` (1) - `jsx-a11y/no-noninteractive-element-interactions` on the `<nav>`: the same roving `tabindex` for Up/Down as `ActivityRail` above, between the section buttons, on a landmark because the rail is `role="toolbar"`-free.
- `components/layout/Dock.tsx` (3) - `jsx-a11y/no-noninteractive-tabindex` three times: the Radix `TooltipTrigger` wires focus and blur to the tooltip holding the engine's address or error text, the same shape again on the save-error tooltip, and again on the version string's worker-count tooltip (issue #1508) - each the only keyboard path to its text.
- `components/layout/PanelResizeHandle.tsx` (1) - `jsx-a11y/no-noninteractive-element-interactions`: the window splitter, with its arrow/Page/Home/End handling in the `onKeyDown` beside it.
- `components/shared/ElementList/ScriptElementForm.tsx` (1) - `jsx-a11y/no-noninteractive-element-interactions`: the script editor's (every `script.*` kind's) height handle, the same window-splitter shape as `PanelResizeHandle` above, with its pointer drag and arrow-key handling in the `onPointerDown`/`onKeyDown` beside it (issue #1605).
- `components/shared/VariableInput/index.tsx` (2) - `jsx-a11y/click-events-have-key-events` and `jsx-a11y/no-static-element-interactions` on the box that widens the hit area around a native input, and `no-static-element-interactions` again on the `pointerEvents: none` overlay whose keydown delegates for the tokens inside it.
- `components/ui/disabled-hint.tsx` (1) - `jsx-a11y/no-noninteractive-tabindex` on the wrapper span that explains a disabled control (issue #1690): the child it wraps is `disabled`, so it is neither focusable nor able to receive a pointer event, and the wrapper's tab stop is the only keyboard path to the reason - the same argument the three `Dock.tsx` tooltips above are suppressed on.
- `modules/collections/CollectionTree.tsx` (1) - `jsx-a11y/interactive-supports-focus`, the roving tab stop seeded by `useRovingTreeFocus`.
- `modules/collections/CollectionItem.tsx` (1) - `jsx-a11y/click-events-have-key-events`: Enter and Space arrive through the tree, which clicks the row's `[data-tree-activate]` button.
- `modules/collections/RequestItem.tsx` (1) - `jsx-a11y/click-events-have-key-events`, the same tree path as its sibling above.
- `modules/history/sidebar/HistoryList.tsx` (1) - `jsx-a11y/no-noninteractive-element-interactions` on the `role="group"` run list:
  roving tabindex for Up/Down/Home/End between the row activators inside (`useHistoryListFocus`), the same Up/Down shape `ActivityRail` uses, on a group rather than a widget role because this flat, occasionally day-headered list has no `listbox`/`tree` selection model to claim.
- `modules/variables/sidebar/VariablesCategoryTree.tsx` (2) - `jsx-a11y/interactive-supports-focus` on the tree and `jsx-a11y/click-events-have-key-events` on its rows.
- `modules/services/ServicesPanel.tsx` (1) - `jsx-a11y/click-events-have-key-events` and `jsx-a11y/no-static-element-interactions`: the drawer-row hit area, which delegates only the clicks landing on the row's own padding.
- `modules/request-builder/components/LoadTestConfigDialog/ProfilePicker.tsx` (1) - `jsx-a11y/interactive-supports-focus`: a radiogroup, where the selected `role="radio"` holds the stop and the `onKeyDown` moves selection and focus together.
- `modules/request-builder/components/RequestTabs/panels/body/graphql-explorer/SchemaExplorer.tsx` (2) - `jsx-a11y/interactive-supports-focus` on the tree, and `jsx-a11y/role-has-required-aria-props` because this tree has no selection model: a row inserts into the query and nothing stays selected, so `aria-selected` is omitted rather than faked.

Test files are outside the count.
Four directives live in two of them, each a fixture modelling one of the patterns above rather than a component the app ships.

## One top heading per tab in full

...(`WelcomeScreen.test.tsx`, `RequestBuilderLayout.headings.test.tsx`, `CollectionDetail.breadcrumb.test.tsx`, `dashboard.breadcrumb.test.tsx`, `HistoryDetail.states.test.tsx`, `VariableTableEditor.banner.test.tsx`, `SettingsMain.category-card.test.tsx`, `SettingsMain.panel-heading.test.tsx`, `InboxView.test.tsx`, `MockServerView.test.tsx`); `Shell.heading-outline.test.tsx`
