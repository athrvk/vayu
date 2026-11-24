---
description: >-
  The accent color schemes applied through `data-color-scheme`, the tokens each one sets and a table of their values.
---

# Color Schemes (Accent Themes)

Applied via `data-color-scheme` attribute on `<html>`.
Each scheme sets `--primary`, `--primary-fill`, `--primary-fill-hover`, `--primary-tint`, `--primary-tint-hover`, `--primary-foreground`, `--ring`, `--variable`, and `--chart-1`.
The authoritative per-scheme values (deep fill + mode-adaptive accent) live in `app/src/index.css`; the table below is an approximate guide.

**`--primary` and `--primary-fill` are not the same thing, and the split is what keeps labels legible.**
`--primary-fill` is the solid button background - the `Button` default variant, badges, tooltips and the Send button all use it - and it holds **one value in both themes**, so the white label on it never changes contrast.
`--primary` is the accent as *text*, focus ring, `--variable` and `--chart-1`; it brightens in dark mode because those all sit on a near-black card and have to read there.
Every bare `bg-primary` in the app is a translucent wash (`/10`, `/15`, `/30`) or a solid with no text on it - `Progress`'s bar (`progress.tsx`), a label-less strip - never a solid fill under white text.

Pinning `--primary` to its light value would look like a contrast fix and is in fact a regression: accent *text* on the dark card would fall from APCA Lc 44–69 to Lc 22–25.

**Secondary text on the fill is a tint of `--primary-foreground`, never `--muted-foreground`.**
The muted token is tuned against the canvas, so on the accent fills it measures 1.04–2.27:1 - on `ocean`, the default, it is 1.04, which is not a de-emphasis but a disappearance.
A tooltip's second line (a shortcut, a URL, the source of a value) therefore uses the `TooltipHint` primitive, which holds the one tint; the same argument `surface-sunken` makes for its `--rule`, on a filled surface instead of a raised one.
The hint cannot out-read the label it is secondary to - white on `coral` is the ceiling at 4.65:1 - so the bar is 2.5:1 on every scheme, checked in `tooltip-hint-contrast.test.ts`.
The same file bans an `opacity-N` or a hand-written `text-primary-foreground/N` inside a `TooltipContent`: white at `opacity-70` measured 2.50:1 on `sunset` before #3499 deepened the fills, and a second alpha is a second unmeasured tint that the next fill retune can put back under the bar.

**A shortcut tooltip is `TooltipShortcutLabel`.**
The label, then the chord in a `TooltipHint`, in one `flex items-center gap-1.5` row - no parentheses, no mono face, no `${label} ${shortcut}` template (which would leave the chord outside the tinted primitive).
`RailButton`, `TooltipIconButton` and the URL bar's `Hint` all render it; a second line such as the rail's gloss stacks beneath as its own `TooltipHint`.
A chord that is *not* in a tooltip (the title-row search bar, the palette's rows) is `Kbd` caps from `chordKeys`. → `tooltip-shortcut-format.test.tsx`

**A value and the hint that sources it stack; they never share a flex row.**
`TooltipContent` is capped at `max-w-xs`, a value that wraps on `break-all` has a min-content width of about one character, and a hint has to keep its intrinsic width to stay readable - so a row of the two hands its whole width to the hint and leaves the value a vertical strip of letter fragments.
It takes only a long environment name beside an unbroken value (issue #1195), or a note carrying the user's own data, such as a declared column list.
`TooltipValue` holds the stacked shape and takes the hint as a prop, so a call site using it cannot express the row; the one-line alternative - `min-w-0 flex-1` on the value plus a truncated hint - was rejected, because a clipped source name loses the answer to "which environment".
A short label beside a short one (`TooltipIconButton`'s shortcut hint) has neither ingredient and stays a row. → `tooltip-value-layout.test.ts` reads every tooltip block for the shape.

`VariablePopover`'s source line is the same rule, one primitive over (issue #1320).
A `truncate` span beside a `shrink-0` chip group (the Enter and Esc keycaps) would clip "Shopify QA - expiring tokens" exactly as an unbroken tooltip value does.
The source stacks under the header, full width, with nothing beside it to hand its space away: a source name never shares a row with something that will not shrink, whether the row is a tooltip's or a popover's.
Because `TooltipContent` cannot see inside a `Popover`, this one is guarded by a rendered-class check in `variable-popover.test.tsx` rather than by `tooltip-value-layout.test.ts`'s block scan.

**The root `TooltipProvider` (`main.tsx`) sets `disableHoverableContent`.**
Every `TooltipContent` in the app is read-only text - no tooltip carries a link or a button - so none needs the grace-area gap hoverable content exists for.
Radix's default builds that gap as a polygon from the pointer's exit point to the content's edges and only closes once a later `pointermove` lands outside it;
a fast flick across two adjacent triggers (the rail's icons, stacked with no gap) can exit the first with its last tracked position already over the second, and no further move ever lands outside the hull - the first tooltip stays open and the second never does, until some unrelated move happens to land outside it.
`disableHoverableContent` closes on leave immediately instead, which is also the macOS system tooltip's own behaviour. → `tooltip-delay.test.tsx`

| Scheme | Light `--primary` | Dark `--primary` | `--primary-fill` (both themes) |
|--------|-----------|----------|----------|
| `sunset` | `24 90% 36%` | `24 95% 58%` | `24 90% 39%` |
| `sky` | `192 95% 28%` | `188 90% 52%` | `192 95% 31%` |
| `ocean` (default) | `217 80% 48%` | `217 90% 66%` | `217 80% 48%` |
| `forest` | `142 72% 27%` | `142 65% 52%` | `142 72% 30%` |
| `aurora` | `262 55% 54%` | `258 88% 76%` | `262 55% 54%` |
| `coral` | `0 68% 47%` | `0 80% 68%` | `0 68% 53%` |
| `magenta` | `305 72% 42%` | `305 85% 70%` | `305 72% 45%` |
| `graphite` | `220 12% 43%` | `220 15% 72%` | `220 12% 46%` |

The opaque fill hover and tints (#3515) are in their own table, because the one above is parsed against the stylesheet column by column.
The tint columns are light and dark values, since a tint is a solid ground and each theme needs the ground that suits it; `--primary-fill-hover` is one value in both themes, like the fill.

| Scheme | `--primary-fill-hover` (both themes) | Light `--primary-tint` | Light `--primary-tint-hover` | Dark `--primary-tint` | Dark `--primary-tint-hover` |
|--------|-----------|----------|----------|----------|----------|
| `sunset` | `24 90% 34%` | `24 100% 97%` | `24 100% 93%` | `24 50% 14%` | `24 50% 18%` |
| `sky` | `192 95% 26%` | `192 100% 91%` | `192 100% 87%` | `188 50% 14%` | `188 50% 18%` |
| `ocean` (default) | `217 80% 43%` | `217 90% 98%` | `217 90% 95%` | `217 50% 14%` | `217 50% 18%` |
| `forest` | `142 72% 25%` | `142 82% 87%` | `142 82% 83%` | `142 50% 14%` | `142 50% 18%` |
| `aurora` | `262 55% 49%` | `262 65% 97%` | `262 65% 93%` | `258 50% 14%` | `258 50% 18%` |
| `coral` | `0 68% 48%` | `0 78% 98%` | `0 78% 95%` | `0 50% 14%` | `0 50% 18%` |
| `magenta` | `305 72% 40%` | `305 82% 98%` | `305 82% 95%` | `305 50% 14%` | `305 50% 18%` |
| `graphite` | `220 12% 41%` | `220 14% 97%` | `220 14% 93%` | `220 15% 14%` | `220 15% 18%` |

Light `sky` and `forest` tints are the strongest because their `--primary` is the deepest; light `ocean`, `coral` and `magenta` the palest, because theirs is the lightest.
The ceiling is the text, not taste: `--primary-text` on the hover tint is what sets how dark a light tint can go, and the guard holds it.

Every scheme also resolves `--primary-text` (the accent as a label).
It tracks `--primary` for all of these except `graphite`, which sets `220 12% 26%` light and `220 15% 86%` dark, and light `sky`, which sets `192 95% 22%` - see **Primary (Accent Color)** above for why.

**Adding a scheme.**
Edit `constants/color-schemes.ts` and `index.css` - nothing else.
`color-schemes.test.ts` asserts the two agree, in both themes, because a missing block fails silently: the picker offers a swatch that inherits `:root` and quietly does nothing.

The values have to clear three bars, and `color-scheme-contrast.test.ts` measures them in both themes.
The fill carries a white label at **4.5:1** (the existing fills land at APCA Lc 76–84); keep it at **3.0+ against `--card`** too, so the button still reads as a control.
`--primary` is text at **4.5:1** on the opaque surfaces: `--card`, `--panel`, `--background`, `--muted` and `--accent`, so in light the darkest of them, `--muted`, sets it.
The opaque tokens are measured there too (#3515): white on `--primary-fill-hover` at **4.5:1** and darker than the fill, and `--primary-text`, `--primary` and `--foreground` each at **4.5:1** on `--primary-tint` and `--primary-tint-hover`, with the two tints a visible step apart.
Pick the tints last, from the accent text: the darkest a light tint can be is set by the lightest text on it.
The dark `--primary` also wants **Lc 44–69** against the dark card.
Check the new hue is more than about **0.10 OKLab ΔE** from every existing scheme *and* from the semantic status colours, or it will read as a duplicate in the picker.
`magenta` sits at ΔE 0.153 from `aurora`; `graphite` is distinct by being the only desaturated option.
