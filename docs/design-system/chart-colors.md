---
description: >-
  The chart series tier, the `-text` variants that make a color legible as text, the contrast bars and how a chart takes its colors.
---

# Chart series and text color tokens

## Chart series tier

A chart series is a stroke or fill on a plot that sits on `--card`, so its job is an icon's: be distinguishable from the surface behind it.
That is not the job `--warning` and `--destructive` are tuned for, and asking them to do both failed in opposite directions - `--warning` measured **2.14** on a light plot (amber is intrinsically light) and `--destructive` **1.73** on a dark one, because in dark it is a deep red chosen to carry a white button label, which all but vanishes on near-black.

```css
/* Light */
--series-success:  142 76% 36%;   /* 3.35 on card */
--series-warning:   38 92% 36%;   /* 3.98 */
--series-danger:     0 84% 48%;   /* 4.87 */

/* Dark */
--series-success:  142 70% 45%;   /* 7.45 */
--series-warning:   38 92% 50%;   /* 8.09 */
--series-danger:     0 84% 60%;   /* 4.57 */
```

Split per theme rather than mode-consistent, because charts re-read their tokens on a light/dark flip (`currentThemeKey`), so neither end has to compromise.
`--warning` and `--destructive` keep their banner and button values and are no longer painted onto a plot or a bar fill on a card: the Rate fidelity card's bar is `--series-*` for the same reason, while its number is the `-text` tier.

`status-token-contrast.test.ts` derives what it checks from `ROLE_TOKEN` itself, so repointing a chart role at a token that fails is caught.
A first version listed the token names by hand and was decorative: pointing the roles back at the button tokens left it green, since it went on checking the `--series-*` values that still existed.

**A legend is built from the series' roles, never written by hand** (#2311).
`ChartLegend` (`dashboard/components/charts/`) takes `{ label, role, shape }` entries and paints each swatch through `ROLE_TOKEN`, the table the canvas resolves its strokes through; a band swatch uses the same `BAND_FILL_ALPHA` as the chart's band fill.
The entries are declared once in `charts/uplot/legend.ts` (`THROUGHPUT_LEGEND`, `LATENCY_LEGEND`, `PERCENTILE_LEGEND`, `SCATTER_LEGEND`) and the lists each card renders sit beside them (`percentileLegend`, `scatterLegend`, `throughputLegend`; the first two list the SLO entry only where the chart draws that line, #2939);
the chart modules build their series and markers from the declarations, and `MetricsView` and History's Performance tab render the same lists (#2697), so the key and the plot read one object.
A hand-written `hsl(var(--x))` swatch is how thirteen legends came to disagree with their charts, nine of them in hue.
`MetricsView.legend.test.tsx` renders the dashboard and checks each entry against the series and markers its card's chart was given; `PerformanceTab.legend.test.tsx` does the same for History.
The status-code legend is the one exception: it is driven by `STATUS_CLASS_CSS_VAR`, the same table its bands resolve through.

**`-text` variants for legible text.**
The base `--success` / `--warning` / `--destructive` tokens are tuned as *fills and indicators*; as small text on a light surface they fall below AA.
Use the darkened (light) / lightened (dark) `-text` variant when the color is the text itself - `text-success-text`, `text-warning-text`, `text-destructive-text` - keeping `bg-*` / `border-*` fills on the base token.

```css
/* Light - accessible text on light surfaces */
--success-text:  142 72% 27%;   --warning-text:  38 90% 30%;   --destructive-text: 0 60% 48%;
/* Dark - accessible text on dark surfaces */
--success-text:  142 60% 55%;   --warning-text:  40 92% 60%;   --destructive-text: 0 65% 65%;
```

**Every `-text` token is solved against the darkest surface it can land on - `--muted`/`--accent` (93%) in light, `--card` (11%) in dark - not against the card.**
That distinction is not academic: tuned against the card, the light green and amber measured 4.04 and 3.57 on `--muted`, so a status message on a tinted chip failed while the same colour on a card passed.
The dashboard's "⚠ ramp off target" is what surfaced it.

The current floor across all four surfaces, both themes, is **4.63** (light amber).
If you add or retune a text token, measure it against all four surfaces, not the one you happen to be looking at.

**The bare token is the fill; the `-text` token is the foreground.**
This is the whole of the rule, and it is worth stating separately because the failure mode is easy to miss: a bare token used as a foreground still *looks* like the right colour, it is just too close in luminance to the surface behind it.
Measured on `bg-card` in the running app (contrast ratio; **bold fails** the 4.5 floor for normal text, and the four values under 3.0 fail the 3.0 icon floor as well):

| family              | light bare | light `-text` | dark bare | dark `-text` |
|---------------------|-----------:|--------------:|----------:|-------------:|
| `destructive`       |       4.87 |          5.48 |  **1.73** |         5.40 |
| `success`           |   **3.33** |          5.71 |      7.46 |         8.81 |
| `warning`           |   **2.13** |          5.46 |      8.13 |         9.81 |
| `status-success`    |   **2.30** |          5.71 |      7.53 |         8.81 |
| `status-error`      |   **3.78** |          5.88 |      4.59 |         5.85 |
| `status-stopped`    |   **2.79** |          5.73 |      6.23 |         7.40 |
| `status-running`    |   **3.64** |          5.99 |      4.77 |         6.75 |
| `status-warning`    |   **3.98** |          5.46 |  **4.35** |         9.81 |
| `status-redirect`   |   **4.34** |          7.86 |  **3.99** |         5.64 |
| `status-no-response`|   **3.98** |          6.69 |  **4.34** |         6.71 |

Which mode a family fails in is not a property of the mode.
`destructive` fails in **dark** alone, the six above it in **light** alone, and the last three - the mode-consistent indicators added for HTTP status - in **both**, because a value tuned to read as a dot on either card is by construction near the middle.
That spread rules out "a dark-mode bug" as the diagnosis: the single cause is the fill token standing in for the foreground one, and which mode it shows up in just depends on where that fill sits relative to the surface.
`destructive` on `bg-destructive/10` and on `bg-background` measures worse still (4.14 / 4.43 light, 1.69 / 1.99 dark), so a tinted error chip is the worst case, not the safe one.

`status-warning` used to be recorded here as an exception with no `-text` variant.
It has one - `--status-warning-text`, holding the same value as `--warning-text` in both themes, which is why its `-text` column repeats that row's figures rather than stating a second number for one colour.
The bare amber is the family's worst case rather than its safe one: 3.98 on the card, 3.63 on `--background`, 3.38 on `--muted` / `--accent` and 3.54 on its own `/10` tint, so it clears the 3.0 icon floor everywhere and the 4.5 text floor nowhere.
The `-text` variant clears both on all four (5.46 / 4.98 / 4.64 / 4.86 light).
Its worst is the `--muted` case the light-amber floor above is quoted from, and the two figures differ in the last place - 4.64 computed from the declared triple, 4.63 measured in the browser, which quantises to 8-bit channels first.
That is the size of the gap between the two methods across this whole page.

Icons count. 1.73 fails the non-text threshold as surely as the text one, so a red `AlertCircle` is in scope, not just the sentence next to it.
So are opacity variants - `text-destructive-text/50` on an error icon is a fainter version of the problem, and on an error affordance the fading is working against the point anyway.
Drop the opacity rather than carrying it over.

One measured surface is worth calling out because it does *not* reach 4.5 even after the fix.
The row-action delete button (`rowActionDestructive`) hovers on `--accent-active`, where the fill token gives 3.66 light / 1.27 dark and `destructive-text` gives 4.12 / 3.96.
Those clear the 3.0 icon floor but not the 4.5 text floor, and the variant is icon-only by design - every call site renders a `Trash2` at `size="icon"`.
Putting a text label in it would stop it passing.

`app/src/components/ui/status-color-tokens.test.ts` enforces this: it fails on any `text-<family>` in `app/src` (including `hover:`/`focus:` prefixes and `/NN` opacity forms) while allowing `bg-*`, `border-*` and `*-foreground`, which are correct uses of the fill token.
It reads the families out of `index.css` - every token declaring both a bare value and a `-text` one in the base palette - rather than listing them, so a family added to the stylesheet arrives guarded.
A hand-written list held seven while the stylesheet had ten.

**Non-text contrast (WCAG 1.4.11) is a separate 3.0 bar**, and it applies to things text contrast never touches: focus rings, control boundaries, and the *states* of a control.
Measured in the running app:

| what | light | dark | verdict |
|------|------:|-----:|---------|
| `--ring` vs every surface | 4.57–5.39 | 5.11–6.75 | passes comfortably |
| `--border` / `--input` vs card | 1.30 | 1.00 | decorative only - see below |
| switch **off** track vs card | 1.55 | 1.28 | failed |
| switch off **thumb** vs its track | 1.41 | 12.35 | failed in light |
| switch **on** track vs card | 5.41 | 3.20 | passes |
| switch on **thumb** vs its track | 4.93 | 4.93 | passes |

**A divider *inside* a card says `border-rule`, not a border token.**
`--border` is tuned for the canvas - its dark value is commented "= rgba(255,255,255,0.07) on dark canvas", where it measures 1.14.
Measured against the surfaces it is actually used on:

| | canvas | panel | card | muted |
|---|---:|---:|---:|---:|
| `--border` | 1.14 | 1.08 | **1.00** | 1.16 |
| `--border-strong` | 1.47 | 1.39 | 1.28 | **1.11** |

At 1.00 the divider is the same colour as the card and simply is not there in dark mode.
`--border-strong` fixes the card (1.28) but is weaker than `--border` on `--muted` in dark, so no single border token serves every surface - which is why the answer is `border-rule` ([below](surfaces.md#border-rule-let-the-surface-pick-the-token)) and the table above is the measurement behind it, not a recipe.
Whether a border sits on a card is an ancestry question a source scan of the `border-*` classes cannot answer; what a test can hold is the *declarations*.
`surface-rule.test.tsx` does that for the surfaces that adopt `surface-card`.
The shared `Card` primitive declares one itself (#2294), so a divider anywhere inside a `Card` is `border-rule` and nothing more; `card.test.tsx` holds the primitive's class list and scans every non-test `.tsx` under `app/src` for a `border-border` (or a side form, `border-t-border`) between a `<Card` and its `</Card>`.
That scan reads the card's own source span, so a border token inside a component a Card merely renders is outside it - the four fixtures that render `CapacitySummary`, `FilesPanel`, `CookiesCard` and `ClientCertificatesCard` cover those by asserting every `.border-rule` has a surface above it.

**Ask what the box sits *on*, not what it is.**
A card's own outline is fine on `border-border`, because that edge faces the canvas, where the token measures 1.14 as designed.
The 1.00 case is a rule *inside* a card.
Both look like `border border-border bg-card` in the source, and only the ancestry tells them apart - so measure the parent's computed background before calling one a defect.

## Charts

A cohesive categorical set - `chart-1` tracks the active accent, then five evenly-spaced hues (teal / violet / amber / rose / moss) shared across modes and tuned only in lightness for each ground.

```css
/* Light */
--chart-1: <accent>;         /* tracks --primary */
--chart-2: 172 66% 38%;   /* teal */
--chart-3: 258 55% 55%;   /* violet */
--chart-4:  38 88% 48%;   /* amber */
--chart-5: 340 72% 50%;   /* rose */
--chart-6: 105 58% 34%;   /* moss */

/* Dark - same hues, lifted for the dark ground */
--chart-1: <accent>;
--chart-2: 172 60% 52%;
--chart-3: 258 78% 72%;
--chart-4:  38 90% 60%;
--chart-5: 340 74% 62%;
--chart-6: 105 52% 50%;
```

`--chart-6` was added for the response timing waterfall, which needs five series at once.
With four fixed hues available, two phases had been reaching outside the set - TTFB to `--primary` and Download to `--success` - and under the green accent those two land on the same hue (142) three points of lightness apart, so two of five phases rendered as the same swatch.
Moss sits in the widest gap in the ring (38 -> 172), 67 degrees from its nearest neighbour.

**A series never takes `--primary` or `--chart-1`.**
Both move with the user's accent, so either can drift onto a neighbouring series in one scheme and not another - which is invisible when you are looking at the scheme it works in.
Its legend swatch takes the series' role too (`ChartLegend`), never a token typed beside it.
