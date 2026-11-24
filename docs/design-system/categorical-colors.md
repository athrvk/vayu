---
description: >-
  The categorical colors: variable scopes, the one decorative palette exception and the HTTP method tokens.
---

# Scope, decorative and HTTP method colors

## Variable Scope Colors (Categorical)

Variable scopes use a **categorical** palette (not semantic status): a distinct hue per scope, mode-adaptive so it reads on both light and dark surfaces.
Used as text/icon/border at full strength and as tinted backgrounds via opacity.

Like the method colours, a scope is painted as text on its own 10% tint (the count badges), so the light values are solved against that wash - at green-700 / orange-700 the badge text measured 4.04 and 3.61.

```css
/* Light */
--scope-global:      142 72% 26%;
--scope-collection:   21 90% 35%;
--scope-environment: 217 91% 45%;   /* blue-600 - already clears it */

/* Dark */
--scope-global:      142 69% 58%;   /* green-400 */
--scope-collection:   27 96% 61%;   /* orange-400 */
--scope-environment: 213 94% 68%;   /* blue-400 */
```

**Utility classes** (`text-`, `bg-`, `border-`, `ring-`, `accent-`): `text-scope-global`, `bg-scope-collection/10`, `border-scope-environment/20`, …

| Scope | Token | Convention |
|-------|-------|-----------|
| Global | `scope-global` | icon/text solid; `bg-scope-global/10` tint |
| Collection | `scope-collection` | icon/text solid; `bg-scope-collection/10` tint |
| Environment | `scope-environment` | icon/text solid; `bg-scope-environment/10` tint |

Never hardcode `bg-green-50 dark:bg-green-950` pairs for scopes - use the token at an opacity (`/10` background, `/20`–`/30` border, full for text/icon).

## Decorative categorical palettes (the one token exception)

A surface may use a **fixed decorative palette** to give items a stable identity by color rather than to signal state - the same idea as `--chart-*`.
Such a palette may keep Tailwind hue utilities (with `dark:` variants) instead of tokens, because it never responds to theme and carries no semantics.

**The list is currently empty.**
Everything - state, status, scope, semantics, and categorical identity alike - uses tokens.

**Three entries were removed because they no longer describe the code.**
The per-section Settings accent palette is gone; there are zero `pink/purple/cyan` utilities left under `modules/settings/`.
The console's Pre-request and Test script groups now use `status-running-*` and `status-success-*` tokens rather than raw `blue-500` / `green-500`, because the raw values were theme-blind and measured 3.76 and 2.22 in light mode; the console body is `bg-muted`, not a fixed `zinc-900` terminal.
And the timing phases - DNS / connect / TLS / TTFB / download - are covered below.

The history overview tiles were on this list too, and should not have been: they encode HTTP severity, which is state.
They use `STATUS_CLASS_STYLE`.

### Timing phases

The five network phases are a categorical set, and they were the last entry here: the history breakdown tinted each tile with an explicit `bg-blue-50 dark:bg-blue-950/30` pair.
They are `--chart-*` now, declared once in `components/shared/response-viewer/timing-phases.ts`:

| Phase | Token |
|-------|-------|
| DNS | `--chart-2` (teal) |
| Connect | `--chart-4` (amber) |
| TLS | `--chart-5` (rose) |
| TTFB | `--chart-3` (violet) |
| Download | `--chart-6` (moss) |

Two rules come with that table.
**Never `--primary` or `--chart-1`** - both follow the user's accent, so either can land on a neighbouring phase's hue; under the green scheme `--primary` and `--success` sat three lightness points apart and two of the five phases rendered as one swatch.
And **colour is only carried where it is the encoding** - the timeline segments in the builder's timing tab and the bars in the dashboard's waterfall, where hue is how you tell the phases apart.
The tile grid (`TimingPhaseTiles`) is deliberately neutral: each tile already has the label written in it, so a hue there was decoration paying for an exception.

The lesson worth keeping: an entry on this list is a claim about the code, and it decays.
A raw palette class here is only defensible if it comes with a `dark:` counterpart - a single value cannot serve a white card and a near-black one, which is why every theme-blind foreground found in this tree failed in light mode and passed in dark.

**`palette-tokens.test.ts` now guards all of `modules/` and `components/`** (issue #1693), not just the request/response tree it was cut for.
The settings restart banner was the last `dark:`-paired holdout, and it moved to the `--warning` family the "Pending" chip one card below it already used - which is the argument for widening: the token existed, the banner just predated it.
Two exemptions are listed in the guard, both `text-purple-500` marking a *load test* (`RunItem`'s bolt, `RunKeyMetrics`'s P99 arrow).
That is a kind rather than a status, so the app's one violet token - `--status-redirect`, which means 3xx - would be the wrong word, and both were measured where they sit (4.36/4.59 and 3.50/3.66 against the 3.0 icon bar) rather than assumed.

## HTTP Method Color Tokens

**Always render methods with `MethodBadge`** (`components/shared`) - never a hand-rolled span or `Badge` with inline colours.
It previously rendered seven different ways (three sizes, two weights, some tinted, two with no colour at all), and the history sidebar kept a private copy of the colour logic that omitted `getMethodColor`'s fallback, so an unrecognised method silently lost its colour.

```tsx
<MethodBadge method={request.method} />                        // tinted chip, 10px
<MethodBadge method={request.method} size="md" />              // 11px, beside body text
<MethodBadge method={request.method} variant="text" />         // colour only, dense rows
<MethodBadge method={m} variant="text" muted={!isActive} />    // secondary context
```

**The `badge` variant is a fixed-width column, not a chip that grows with its letters.**
Every list that shows one puts the badge first and the name after it, so an intrinsic-width chip started `GET` names at one x, `POST` names at another and `DELETE`/`OPTIONS` further still - a ragged left edge down the collections tree, the history sidebar and the welcome recents at once.
The chip is `5ch` wide plus its own padding and border (`ch`, so one class serves both sizes and tracks the mono font it already uses), five being the longest label that stays whole - `PATCH`.
The label is centred, and a longer method (the engine and a pasted `curl -X` both pass arbitrary strings) truncates inside the chip with the full method on the element's `title`, rather than widening it and re-breaking every row around it.

**The three standard methods longer than the column are abbreviated.**
`DELETE`, `OPTIONS` and `CONNECT` render as `DEL`, `OPT` and `CONN` - the substitutions Postman, Insomnia and Bruno all use - and the full name is one hover away on the same `title` that reveals a truncated custom method.
The abbreviation table lives beside `getMethodColor` in `utils/helpers.ts` (`METHOD_ABBREVIATIONS`, read by `getMethodDisplayLabel`), for the same reason: one value, one meaning everywhere.
The column paid `7ch` on every row for two verbs almost nobody has in a tree; at `5ch` the collections sidebar gives the request name roughly a third of the row back.

| Method | Column label | Title on hover |
|--------|--------------|----------------|
| `GET`, `POST`, `PUT`, `PATCH`, `HEAD` | as written | none |
| `DELETE` | `DEL` | `DELETE` |
| `OPTIONS` | `OPT` | `OPTIONS` |
| `CONNECT` | `CONN` | `CONNECT` |
| longer custom (`PROPPATCH`, …) | truncated | full method |

The width is not an opt-in prop - the primitive enforces it, which is the whole reason this component exists.
The `text` variant keeps its intrinsic width: it sits inline in running text, where a fixed column would punch holes, and a caller that wants a column there sets its own.
Two callers do: the import preview (`w-10`) and the collections tree row (`w-[5ch]`, matching the badge column so `DELETE` still fits).
The tree row uses the text variant because a bordered chip on every row was a second shape competing with the tree's own hover fill and selection ring; colour alone carries the signal there.

Method colors are design tokens, not hardcoded hex values.
**They are mode-adaptive** - hue and saturation are identical in both themes, so a method always reads as "its" colour; only lightness shifts.

They have to be.
`MethodBadge` paints one value three ways at once - as text, as a 10% tinted background, and as a 30% border - so the badge text sits on a wash of itself and contrast comes down entirely to lightness.
As a single mode-consistent set, 10px badge text failed AA in **both** themes at once: PUT measured 1.97:1 in light, PATCH 2.86:1 in dark.
Each value below is solved against its own tint over the worst surface of its theme, and clears 4.6:1.

```css
/* light */                      /* dark */
--method-get:     142 76% 25%;   /* 142 76% 45% - green  */
--method-post:    217 91% 45%;   /* 217 91% 63% - blue   */
--method-put:      38 92% 28%;   /*  38 92% 45% - amber  */
--method-patch:   262 83% 45%;   /* 262 83% 71% - purple */
--method-delete:    0 84% 42%;   /*   0 84% 65% - red    */
--method-head:    199 89% 31%;   /* 199 89% 45% - cyan   */
--method-options: 240  5% 41%;   /* 240  5% 58% - gray   */
```

There is no `.method-get` or `.bg-method-get` utility class: the colour is read through `getMethodColor` below, the one path `MethodBadge`, the tab strip and the method selector all take.
A second way to spell the same colour is a second place for it to drift.

**`getMethodColor(method)`** in `app/src/lib/method-display.ts` returns `var(--method-xxx)` - the raw CSS variable reference.
Callers construct full color values:

```tsx
const c = getMethodColor(method); // e.g. "var(--method-get)"

// Solid color (text, stroke):
color: `hsl(${c})`

// Tinted background (~10% opacity):
background: `hsl(${c} / 0.1)`

// Tinted border (~30% opacity):
borderColor: `hsl(${c} / 0.3)`
```

**Do not hand-roll that span for a method.**
This section used to carry the badge's markup as a pattern to copy, naming `RunItem` and `DashboardHeader` as its users;
both have rendered `MethodBadge` for some time, and the copy here had already drifted (`font-bold` against the primitive's `font-semibold`, `rounded` against `rounded-md`, and no fixed width at all - so a copy of it would have reintroduced the ragged left edge the primitive now prevents).
A hand-rolled copy of a primitive does not receive the primitive's fixes.
Render `MethodBadge`; the three `hsl()` forms above are how it, the tab strip and the method selector each build a colour from `getMethodColor`.

**MethodSelector** used to carry its own `METHOD_COLORS` map of those utility classes - a second source of truth for the same seven colours, and the kind that quietly stops matching.
It now takes the `getMethodColor` path above, like `MethodBadge` and the tab strip:

```tsx
style={{ color: `hsl(${getMethodColor(request.method)})` }}
```
