---
description: >-
  The primary accent token, the semantic status colors and the run and status indicator colors.
---

# Accent and status color tokens

## Primary (Accent Color)

Set by the `[data-color-scheme]` attribute; the default is **Ocean** (`DEFAULT_COLOR_SCHEME` in `constants/color-schemes.ts` is the source of truth).
The accent is **split into two tokens** to resolve a contrast bind, and three opaque companions (below) give its hover and its tint a solid colour of their own:

- **`--primary`** - the accent used for text, borders, rings, indicators (`text-primary`, `border-primary`, `ring-primary/20`).
  A chip or row ground under text is not an alpha of it but `--primary-tint` (below).
  Mode-adaptive: deep on the light card, brightened on the near-black dark canvas so it reads in both.
- **`--primary-fill`** - solid button/badge backgrounds that carry a white label (`bg-primary-fill`).
  One value in **both** modes, deep enough that white text clears 4.5:1 (a brightened dark accent would fail white-on-fill).

**The opaque companions (#3515).**
A translucent accent alpha puts text on a colour that depends on whatever is behind it, so `hover:bg-primary-fill/90` measured 4.03-4.09:1 under a white label on six schemes and `bg-primary/15` under `text-primary` 4.32-4.42:1 on a white card.
Each scheme instead declares three solids, plain `H S% L%` triples the contrast guard parses:

- **`--primary-fill-hover`** - the fill's hover (`hover:bg-primary-fill-hover` on `Button`'s default variant, `Badge`'s default variant and the URL bar's Send pair; the border moves with it).
  A few points darker than the fill, so the white label *gains* contrast on hover instead of losing it.
  Pinned across themes with the fill.
- **`--primary-tint`** and **`--primary-tint-hover`** - a solid chip background and its hover (`bg-primary-tint`, `hover:bg-primary-tint-hover`) under `--primary-text`, in place of `bg-primary/15` and `hover:bg-primary/20` wherever the element carries text.
  A light solid in light, a dark solid in dark, so unlike the fill they differ per theme.
  `--primary-text`, `--primary` and `--foreground` all clear 4.5:1 on both.
  Light `ocean`, `coral` and `magenta` are the binding cases: their `--primary` was set by the surfaces and sits barely above 4.5:1 on white, so their tint is the palest.

**The rule: an alpha of the accent (`bg-primary/<n>`, `bg-primary-fill/<n>`, `bg-status-<name>-fill/<n>`, and their `hover:` / `disabled:` / `data-[...]:` forms) is allowed only where no text sits on it** - a dot, a ring, a selection outline, a chart area, a text-selection highlight over transparent text.
An element that renders text, its own or its children's, uses the opaque tokens: `bg-primary-tint` at rest, `hover:bg-primary-tint-hover` when it is already tinted and `hover:bg-primary-tint` when it is not.
`accent-alpha-under-text.test.ts` scans every non-test source file and fails on any other use; a genuinely text-free one goes in its allow-list with the reason.
The per-scheme values are in the second table under [Color Schemes](color-schemes.md#color-schemes-accent-themes).

Both halves meet **4.5:1 in every scheme and both themes** (#3499): `--primary` as text on `--card`, `--panel`, `--background`, `--muted` and `--accent`, and white on `--primary-fill`.
The light `--primary` is set by the darkest light surface (`--muted`, 93%) and the fill by the white label, so in six schemes the light fill sits three to six points lighter than the light text accent; they are two jobs, not one colour.
`color-scheme-contrast.test.ts` measures every cell from the stylesheet.

Rule: white-labelled solid fills use `bg-primary-fill` - a checked checkbox under its white check and an on switch under its thumb included (#2305); everything else accent uses `--primary`.
`--primary-foreground` (white) sits on the fill.

```css
/* Sunset (the values below; the default scheme is Ocean) */
--primary:       24 90% 36%;   /* light - deep accent */    /* dark: 24 95% 58% (brighter) */
--primary-fill:  24 90% 39%;   /* both modes - white-safe button fill */
--primary-fill-hover: 24 90% 34%;   /* both modes - the fill's hover, white-safe */
--primary-tint:       24 100% 97%;  /* light - solid chip ground */  /* dark: 24 50% 14% */
--primary-tint-hover: 24 100% 93%;  /* light - its hover */          /* dark: 24 50% 18% */
--primary-text:  var(--primary);   /* accent as a label - see below */
--primary-foreground: 0 0% 100%;
--ring / --variable: track --primary
```

**`--primary-text` - the accent when the accent *is* the label.**
Used by the section tabs for the active trigger (`text-primary-text`) and by a resolved `{{variable}}` token, where the accent has to separate not from the surface but from the `--muted-foreground` label (or empty token) beside it.

It is not sufficient on its own, and the tabs pair it with a 2px underline on `--primary`.
Colour plus weight leaves the active tab hard to find in graphite, where the accent is a neutral: the label then differs from an inactive one in lightness alone, and 12px at 600 against 500 is a difference you have to hunt for.
A rule is a *shape*, which no accent can wash out.
Note the split - the label takes `--primary-text` and the indicator takes `--primary`, because one is text and the other is an indicator.

That separation is carried almost entirely by **saturation**, not lightness.
Measured on `--card`, accent text and muted text sit within a **1.01-1.45** contrast ratio of each other in every scheme - effectively the same brightness - so what the eye reads is "coloured vs grey".
At 55-95% saturation against an inactive 4-5% that is usually plenty, which is why `--primary-text` defaults to `--primary` and six of the eight schemes never override it.

`graphite` overrides it, because it is the only desaturated scheme (S=12% light, 15% dark) and so has no hue to spend: `220 12% 26%` light and `220 15% 86%` dark, which take its active-vs-inactive separation from 1.02 to 1.86 and 1.23 to 1.81.
Light `sky` overrides it as well, with `192 95% 22%`: a cyan dark enough to clear 4.5:1 on `--muted` has given up most of its chroma, and at its `--primary` it sits 0.088 OKLab from `--muted-foreground`, where under 0.10 reads as the same colour (#3499).
Dark `sky` resets the alias to `var(--primary)`, because the light block's literal ties `.dark` on specificity and would otherwise reach dark too.
Retuning graphite's `--primary` instead is not an option - that also paints its ring, `--chart-1` and every `text-primary`, near-black in light.
This is the same bind `--primary-fill` exists to solve, answered the same way.

**Adding a scheme:** declare all three opaque tokens in the scheme's light block *and* its dark block (`:root` and `.dark` carry Sunset's), because a token a `.dark[data-color-scheme]` block leaves out falls through to the light value of its scheme; `color-schemes.test.ts` lists them in `REQUIRED` and `color-scheme-contrast.test.ts` measures them.
Then override `--primary-text` if the accent's saturation is under about 25%, or if the accent sits within 0.10 OKLab of `--muted-foreground`.
`color-schemes.test.ts` derives the first rule from the stylesheet rather than naming graphite, so a new desaturated scheme fails until it declares one; `color-scheme-contrast.test.ts` measures the second, as the resolved-versus-empty pair of the variable states.
It is deliberately *not* in `color-schemes.test.ts`'s `REQUIRED` list - inheriting it is usually correct, not a forgotten block.

Note the ratios above are between two *foreground* colours; neither WCAG nor APCA is defined for that, so treat them as a discriminability proxy rather than a conformance figure.

## Semantic Status Colors

These differ between light and dark mode.

```css
/* Light */
--success:            142 76% 36%;   /* green */
--warning:             38 92% 50%;   /* amber */
--info:               199 89% 38%;   /* cyan */
--destructive:          0 84% 48%;   /* red */

/* Dark */
--success:            142 70% 45%;   /* lighter green */
--warning:             38 92% 50%;   /* same */
--info:               199 89% 55%;   /* brighter on a dark plot */
--destructive:          0 62.8% 30.6%;  /* darker red */
```

There is no `--success-foreground`, `--warning-foreground` or `--info-foreground`: a white label on a bare `--warning` measures 2.14:1, and nothing read the other two.
A solid status control takes the `-fill` token under a white label instead (`bg-status-warning-fill text-white`, 4.62:1 - the Restart engine button, the client-certificate chip).
Its hover is the opaque `--status-warning-fill-hover` (`hover:bg-status-warning-fill-hover`, 5.70:1), never `hover:bg-status-warning-fill/90`, which composites to 3.87:1 under the same label.

`--info` is split by mode, unlike `--warning`.
One value, `199 89% 48%`, scores **2.85** on a light card against the 3.0 bar - while painting three chart series (wire, send rate, connections).
Mode-consistency is deliberate for the `--status-*` indicators, where one value must read as the same signal on either surface; `--info` had no such reason, so it is split like everything else here.

## Run / Status Indicator Colors

Run, connection, and test status (dots, left-bars, pills, status icons) use a cohesive `--status-*` set.
Unlike everything else, these are **mode-consistent** - the same value in light and dark - because a status dot should read as the same "good / bad / busy" signal on either surface.
Distinct from `--success` / `--destructive`, which are tuned for banner text and button fills respectively.

```css
--status-success: 142 71% 45%;   /* green-500  - completed / connected / pass */
--status-error:   0 84% 60%;     /* red-500    - failed / test fail */
--status-running: 217 91% 60%;   /* blue-500   - running */
--status-stopped: 25 95% 53%;    /* orange-500 - stopped */
/* pending → text-muted-foreground / bg-muted-foreground */

/* The HTTP-status half of the same family, added with that vocabulary below.
   Amber cannot follow the -500 convention - see the note further down. */
--status-redirect: 258 60% 62%;     /* violet  - 3xx, redirect */
--status-no-response: 240 5% 52%;   /* neutral - status 0, nothing came back */
--status-warning: 38 92% 36%;       /* amber   - 4xx, client error */
--status-warning-fill-hover: 38 92% 29%;   /* the warning fill's hover, white-safe */
```

**A status colour has three jobs, and three tokens.**
The base value above is tuned as an *indicator* - a dot, a bar, an icon - where only 3:1 is required.
Reuse it as text or as a solid chip and it fails: `status-success` measured **2.21:1** as 12px text on the light panel and **2.30:1** as white-on-fill.

| Job                                       | Token                    | Example                        |
| ----------------------------------------- | ------------------------ | ------------------------------ |
| Dot, bar, icon, tint, border              | `--status-*`             | `bg-status-success` dot        |
| The colour **is the text**                | `--status-*-text`        | `text-status-error-text`       |
| Solid chip under a **white** label        | `--status-*-fill`        | `bg-status-success-fill`       |
| That chip's **hover**                     | `--status-*-fill-hover`  | `hover:bg-status-warning-fill-hover` |

Only `-text` is mode-adaptive (light needs a darker value, dark a lighter one).
The base indicators and the `-fill` chips stay mode-consistent, so a green dot and a "200 OK" chip read identically on either theme.
This is the same split `--primary` / `--primary-fill` already uses.

Only `--status-warning-fill-hover` exists so far (`38 92% 29%`, one value in both themes, 5.70:1 under white against the fill's 4.62:1), because the Restart engine button is the one solid status control with a hover.
A `/<n>` alpha of any `bg-status-<name>-fill` is refused by `accent-alpha-under-text.test.ts`, as `bg-primary/<n>` is (#3499).

**Utility classes** (`text-`, `bg-`, `border-`): `text-status-success-text`, `bg-status-error-fill`, `border-status-running/25`, etc.
Use `--warning` for "expiring / caution" indicators (amber) and `--success` for success *banners*.

**Which family a surface belongs to is decided by what it describes, not by the colour it wants.**
Anything painting the lifecycle state of a run, a connection or a service - connected, running, completed, stopped, failed - takes `--status-*`, including when that state is drawn as text or as a glyph rather than as a dot (`text-status-success-text`).
The Dock's connection light and its running-services chip, the Services panel dot, the mock-server glyph, the MCP server's Running / Stopped badge and the Welcome screen's recent-run labels are all that case.
`--success` / `--warning` / `--destructive` keep everything else, and the boundary is worth naming because several of them look close:
banner text, form and field errors, a schema's fetch or validation outcome (the context bar's GraphQL state, the body panel's schema badge), metric readouts such as the dashboard's "ramp off target" and `ThroughputTwinCard`'s delta chip -
a number against a target is not a lifecycle - and action affordances such as the Dock's "Restart pending", which announces a pending setting rather than a state.
`--success-text` and `--status-success-text` are the same value in both themes, so on the green surfaces this distinction is not visible - it is only greppable, which is what it is for: the family is how a future reader finds every status surface, and one that answers a different name is one it will miss.

The same set also colors **HTTP response severity** and **latency thresholds**, since those map onto the same hues.

**HTTP status classes have their own vocabulary**, in `constants/http-status.ts`.
Never re-derive it: `httpStatusClass(code)` gives the class, `STATUS_CLASS_STYLE[class]` gives the utility for the surface role you need (`fill` / `text` / `tint`; there is deliberately no `indicator`), and `STATUS_CLASS_CSS_VAR[class]` gives the custom property for an inline swatch.
A bar that buckets codes (the Error rate card) keeps the engine's error tally through `isErrorStatus`, not `httpStatusClass` alone, and paints each bucket from the class it represents.
Guarded by `http-status.test.ts`, which fails if a component classifies a code and picks a colour inline, in two shapes:
a status branch with a colour class or a `variant=` prop within three lines, and a file that holds a status range comparison (`status >= 500`) and anywhere paints a bare `--success` / `--warning` / `--destructive` colour (a class, an `hsl(var(...))` or `variant="destructive"`) without importing `@/constants/http-status`.

| Class | Codes | Family |
|-------|-------|--------|
| `success` | 2xx | `status-success` |
| `redirect` | 3xx, and 1xx | `status-redirect` (violet) |
| `client-error` | 4xx | `status-warning` (amber) |
| `server-error` | 5xx | `status-error` |
| `no-response` | `0`, and anything not a valid code | `status-no-response` (neutral) |

**This table has now been corrected twice, in opposite directions, so the reasoning is recorded rather than the conclusion alone.**
The rejected mapping put 3xx on `status-warning-fill` and 4xx on `status-stopped-fill`.
That ramp reads as principled - green to amber to orange to red - but it packs four classes into 38deg-0deg of hue, and measured as OKLab distance three of its ten pairs collide: 3xx/4xx at 0.073, 4xx/5xx at 0.095, and 5xx against a connection failure at **0.000**, because both used `status-error-fill`.
The set above has no pair under 0.144.

3xx is violet because that is where the wheel has room.
Excluding the hues the other classes own and requiring 3.0 on both card surfaces, the best-separated free band is 262-294; violet scores 0.202 against its siblings where blue manages 0.134, and blue is already `--status-running`, which appears in the same History row.
Hue 258 rather than 262 so it matches `--chart-3`, which is what the dashboard chart paints 3xx with.

A violet accent scheme (Aurora) sits 0.068 from it, which sounds disqualifying and is not: *every* existing status indicator already collides with some accent (`--status-stopped` is 0.023 from Sunset), and none of those is a defect, because a status dot and an accent button are different UI roles.
The 0.10 bar is a chart-series rule, where colour is the sole encoding within one plot.

`--status-warning` completes a family that only ever had a `-fill`, which is why the history tiles used raw `yellow-700`.
Amber cannot follow the `-500` convention: amber-500 (`38 92% 50%`) measures **2.14** on a light card.
The indicator sits at `38 92% 36%`, only 3 points from its own fill - amber is squeezed from both ends, which is a property of the hue, not a mistake.

**The status-code chart uses this family too**, through dedicated `status-*` roles in `uplotTheme`.
The other charts keep the generic `success` / `warning` / `destructive` roles, and must: those are a *series* palette wearing semantic names, and `success` / `warning` also paint the rate charts' achieved and configured-band series, `destructive` the error-rate area.
They do not paint p50 / p95 / p99: a percentile's name is not a verdict (#2245).
Repointing them at `--status-*` would recolour the rate and error-rate charts, which have nothing to do with HTTP status.

That distinction was got wrong first time round.
The status chart borrowed `categorical` for 3xx and `muted` for a failed connection, and this document claimed the chart therefore "taught the same violet" as the response badge.
It did not: `categorical` is `--chart-3`, which also paints the p99 scatter, the HDR distribution, the latency breakdown and the **throughput area**.
So violet meant "the categorical series in this plot", not "redirect", and a user could not learn the association from a dashboard where violet is throughput one chart higher.
`muted` had the same problem in reverse - it made "nothing came back" read as de-emphasised rather than as an outcome of its own.

The history latency tiles are neutral and use `status-stopped` (P95) or `status-error` (P99, P999) only when the value exceeds the run's own SLO (`LatencyMetric.tsx`, #2245; a run that declared none stays neutral, #2939), and a tile in a tier also carries an `AlertTriangle` and a screen-reader "Over SLO: " so the state is not colour alone (#3499);
the percentile lines in the time-series chart take no status role at all, and the HDR distribution's p95 / p99 markers take `warning` / `destructive` only past the SLO (`hdrMarkers.ts`, #2263).
