# One colour vocabulary for HTTP status classes

**Date:** 2026-07-22
**Branch:** `welcome-screen-redesign`
**Status:** approved, not yet implemented

## Why

This started from a note in the PR description that read:

> Deliberately **not** done: `LoadTestConfigDialog`'s palette classes are proper
> `light dark:` pairs, which are theme-aware and so are not the defect above —
> converting them needs new tokens (there is no purple or info `-text` token)
> and is a design decision. Likewise the history tabs and settings banners.

Two thirds of that note is stale, and the third is a different problem than it
describes.

**`LoadTestConfigDialog` has no palette classes.** Commit `1a1cac4` moved its
five notice treatments into `components/shared/Callout.tsx`, which is fully
tokenised (`--destructive`, `--warning`, `--warning-text`). Nothing to convert.

**The two `text-purple-500` icons were already audited.** `LoadTestDetail.tsx`
and `RunItem.tsx` both carry measured comments — 3.50/3.66 and 3.93/4.59 against
the 3.0 icon bar, clearing it in both themes. They were deliberately kept, not
left pending.

**What is actually wrong is not tokenisation.** The app classifies HTTP status
codes for colour in **five** places and gives **four different answers for 3xx**.

| Site | 2xx | 3xx | 4xx | 5xx | status 0 |
|---|---|---|---|---|---|
| `ResponseViewer/ResponseHeader.tsx` | `status-success-fill` | **`status-warning-fill`** (amber) | `status-stopped-fill` | `status-error-fill` | `status-error-fill` |
| `shared/response-viewer/UnifiedResponseViewer.tsx` | `status-success-fill` | **`status-warning-fill`** | `status-stopped-fill` | `status-error-fill` | *no special case* |
| `dashboard/…/StatusCodesOverTimeChart.tsx` | `success` | **`categorical`** (violet) | `warning` | `destructive` | `muted` |
| `history/…/OverviewTab.tsx` | `green-*` | **`blue-*`** | `yellow-*` | `red-*` | `red-*` |
| `dashboard/…/RequestResponseView.tsx` | `status-success-text` | **`status-running-text`** (blue) | `warning-text` | `status-error-text` | — |

4xx has three answers as well: `status-stopped` (orange), `warning` (amber), and
raw `yellow-700`.

This is the same defect class as the load-test mode vocabulary already fixed on
this branch in `fff2804` — one concept, several hardcoded answers, drifting
apart. It is not a raw-palette problem: four of the five sites are already using
tokens, just *different* ones.

Two secondary findings fall out:

- `ResponseHeader` and `UnifiedResponseViewer` are near-duplicate copies of the
  same badge. The copy lost the `status === 0` special case, so a connection
  failure renders as a literal **`0`** chip there instead of `ERR`.
- In `OverviewTab`, a 5xx and a connection failure are the same red, so at a
  glance you cannot tell "the server returned an error" from "there was no
  server".

## Scope of the honesty claim

The badge and the tiles both print the status *number*, so colour there is
redundancy, not the sole encoding. A collision costs scanability, not
correctness. The one place colour was the whole encoding — the stacked
status-code chart — was already fixed earlier on this branch.

So the win here is **a single vocabulary**, not a bug fix. A user who learns
"violet means redirect" from the dashboard should not then meet an amber `301`
in the response pane. The two genuine defects are the duplicated badge's lost
`status === 0` case and the 5xx/no-response collapse in the tiles.

## Decision

Adopt the chart's mapping as canonical, extended with an explicit
"no response" class.

| Class | Codes | Token family |
|---|---|---|
| `success` | 2xx | `status-success` |
| `redirect` | 3xx | `status-redirect` *(new)* |
| `client-error` | 4xx | `status-warning` *(triad completed — see below)* |
| `server-error` | 5xx | `status-error` |
| `no-response` | `0` | `status-no-response` *(new)* |

### What is unified, and what deliberately is not

**The classification is unified. The palettes are not.** This distinction is the
whole design and it is easy to misread, so it is stated before anything else.

The dashboard chart does not paint from `--status-*` at all. `uplotTheme.ts`
resolves its roles to the *semantic* family — `success → --success`,
`warning → --warning`, `destructive → --destructive`,
`categorical → --chart-3` — and those hold different values from the
`--status-*` set (`--warning` is `38 92% 50%`; `--status-warning` will be
`38 92% 36%`).

That split is correct and stays. A chart series is a translucent area fill on a
plot background; a badge is a solid chip under a white label; a tile is a 10%
wash. They are different optical problems and already have different tiers for
that reason.

So what every site comes to share is **`httpStatusClass(code)`** — the decision
about *which class a code belongs to*, and therefore which hue family it gets.
Each tier then resolves that class through its own palette. Concretely:

| | resolves through |
|---|---|
| DOM surfaces (badge, tiles, counts) | `STATUS_CLASS_STYLE` → `--status-*` |
| uPlot series | `ROLE_TOKEN` → `--success` / `--warning` / `--destructive` / `--chart-3` |

The consequence to accept openly: **`--status-redirect` and `--chart-3` are two
tokens for one concept.** They are the same hue (258) by construction, and
`--status-redirect-text` in dark is deliberately byte-identical to `--chart-3`
dark, but they are not one source of truth and will not track each other
automatically. A comment on each pointing at the other is the mitigation, plus
the separation guard in (3).

The alternative — pointing the chart's roles at `--status-*` — would be a true
single source, but it recolours the dashboard: dark-mode 3xx would drop from a
bright 72% violet to a muted 62% one, and 4xx from 50% to 36%. That is a visible
change to a surface nobody has screenshotted, for a consistency nobody can see.
Rejected.

**`status-warning` is not a complete triad today.** Only
`--status-warning-fill` exists — there is no `--status-warning` indicator and no
`--status-warning-text`. That is why `OverviewTab` reaches for raw `yellow-700`
for 4xx: there was no token to use. The triad has to be completed for the
vocabulary to be uniform.

The reason it was never completed shows up immediately on measuring: amber-500
(`38 92% 50%`, the value `--warning` holds) is **2.14 on a light card**, well
under the 3.0 icon bar. Amber is intrinsically light, so a mode-consistent
indicator has to sit much darker than the other `-500`-family status colours.
`38 92% 36%` measures 3.98 light / 4.35 dark and clears both.

A consequence worth naming: at `36%` the indicator lands only 3 points from
`--status-warning-fill` (`33%`), where the other families separate widely
(success 45 vs 30, error 60 vs 49). Amber is squeezed from both directions —
dark enough to read on white, dark enough to carry a white label — so the two
tiers legitimately converge. That is a property of the hue, not a mistake.

### Why the chart's mapping and not the badge's

Measured as OKLab distance between every pair of classes. Under ~0.10 two
colours read as the same; the codebase already uses that threshold for accent
placement.

| pair | badge mapping | chart mapping |
|---|---|---|
| 3xx / 4xx | **0.073** | 0.406 |
| 4xx / 5xx | **0.095** | 0.247 |
| 5xx / err | **0.000** | 0.234 |
| worst pair | **0.000** | 0.173 |

The badge's green→amber→orange→red "severity ramp" looks principled but packs
four classes into 38°–0° of hue, so three of its ten pairs collide. The chart's
has none.

### Why violet for 3xx

Violet was challenged during design on the grounds that it collides with the
Aurora accent (dE 0.068 in light). **That objection does not bind**, and
checking rather than assuming is what settled it: every existing status
indicator already collides with some accent —

| token | nearest accent | dE |
|---|---|---|
| `--status-stopped` | Sunset (dark) | 0.023 |
| `--status-success` | Forest (dark) | 0.048 |
| `--status-error` | Coral (light) | 0.047 |
| `--status-running` | Ocean (dark) | 0.059 |

— and none of those is considered a defect, because a green "completed" dot next
to a green accent button is not a misread. They are different UI roles. The 0.10
bar is a **chart-series** rule, where colour is the sole encoding within one
plot. Applying it app-wide would forbid every status colour the app already has.

The criterion that *does* bind is separation from the other status classes.
Sweeping the wheel for hues that clear 3.0 on both card surfaces and stay ≥0.10
from all four siblings, the best-separated free band is **262–294** — violet into
magenta:

| hue | best min dE to siblings |
|---|---|
| 294 (magenta) | 0.238 |
| **262 (violet)** | **0.202** |
| 236 (indigo) | 0.191 |
| 210 (blue) | 0.134 |
| 30 (orange) | 0.123 |

Violet is where the wheel has room, not an arbitrary leftover. Hue **258** is
chosen over the sweep's 262 to be hue-identical with `--chart-3`, so the
dashboard chart and the response pane teach the same violet; 4° is imperceptible.

Runners-up and why not:

- **Blue 210–217** — conventional for "informational", but `--status-running` *is*
  `217 91% 60%`. A 3xx chip and a "run in progress" dot would be the same blue,
  and a History row renders both. That is a same-role collision, which does bind.
- **Magenta 294–320** — separates best, but Magenta is now an accent scheme, and
  unlike accent-vs-status these are both *identity* colours competing in the
  picker.

## Token additions

Following the existing three-tier architecture exactly: indicator and fill are
**one value across both themes** (a status chip should read identically on either
surface); only `-text` splits per theme.

```css
/* :root — light */
--status-redirect:          258 60% 62%;
--status-redirect-text:     258 62% 48%;
--status-redirect-fill:     258 60% 46%;
--status-no-response:       240  5% 52%;
--status-no-response-text:  240  6% 38%;
--status-no-response-fill:  240  6% 40%;
--status-warning:           38 92% 36%;   /* completes an existing partial triad */
--status-warning-text:      38 90% 30%;

/* .dark — only the -text tier changes */
--status-redirect-text:     258 78% 72%;
--status-no-response-text:  240  6% 65%;
--status-warning-text:      40 92% 60%;
```

Eleven declarations, plus six `--color-status-*` bridge lines in the `@theme`
block so Tailwind generates the utilities.

Measured — every tier of all five classes, so the new values are checked in the
context they will actually be used:

| class | tier | value | light | dark | bar |
|---|---|---|---|---|---|
| redirect | indicator | `258 60% 62%` | 4.34 | 3.99 | 3.0 |
| | text | `258 62% 48%` / `258 78% 72%` | 6.96 | 5.08 | 4.5 on 10% tint |
| | fill | `258 60% 46%` | 8.22 | — | 4.5 white label |
| no-response | indicator | `240 5% 52%` | 3.98 | 4.34 | 3.0 |
| | text | `240 6% 38%` / `240 6% 65%` | 5.99 | 5.97 | 4.5 on 10% tint |
| | fill | `240 6% 40%` | 6.21 | — | 4.5 white label |
| warning | indicator | `38 92% 36%` | 3.98 | 4.35 | 3.0 |
| | text | `38 90% 30%` / `40 92% 60%` | 4.86 | 8.78 | 4.5 on 10% tint |
| | fill | `38 92% 33%` *(exists)* | 4.62 | — | 4.5 white label |

**Two pre-existing indicators are under the 3.0 bar and are not touched here.**
`--status-success` measures 2.30 on a light card and `--status-stopped` 2.78.
Both are deliberate: `index.css` states the four original indicators are
mode-consistent so "a green dot reads as 'good' on either surface", trading the
icon bar for that consistency. Recording it because it is surprising, not
proposing to change it — that is a separate decision with a wide blast radius.

`--status-redirect-text` dark is `258 78% 72%`, byte-identical to `--chart-3`
dark. That is deliberate but narrow: it makes the *dark text* tier land exactly
on the chart's violet. The other tiers do not coincide — the badge fill is
`258 60% 46%` and the chart band is `--chart-3` — and they are not meant to. What
is shared is hue 258, per the tier split above.

Resulting five-class separation at the indicator tier: worst pair **0.144**
(client-error vs no-response), against the badge mapping's current **0.000**.
Both members of that pair are values this change introduces, so the number is
under our control if it ever needs widening.

**Naming note.** `--status-no-response` is verbose, and
`text-status-no-response-text` more so. It is preferred over `--status-offline` /
`--status-unreachable` because status `0` covers DNS failure, TLS failure,
timeout and refusal alike — "no response" is the only accurate one-phrase name.
Verbosity in a token name is cheaper than ambiguity.

## The vocabulary module

`app/src/constants/http-status.ts`, mirroring the shape of the `load-test.ts`
mode vocabulary:

```ts
export type HttpStatusClass =
  | "success" | "redirect" | "client-error" | "server-error" | "no-response";

/** `0` (and anything non-numeric) is no-response, not a server error. */
export function httpStatusClass(code: number): HttpStatusClass;

/** Complete utility classes per class, keyed by the surface role. */
export const STATUS_CLASS_STYLE: Record<HttpStatusClass, {
  /** Solid chip under a white label — the response badge. */
  fill: string;      // e.g. "bg-status-redirect-fill"
  /** The colour IS the text — a status number, a count. */
  text: string;      // e.g. "text-status-redirect-text"
  /** Tinted panel behind other content — the history tiles. */
  tint: string;      // e.g. "bg-status-redirect/10"
  /** Dot, icon, bar. */
  indicator: string; // e.g. "text-status-redirect"
}>;

/** Human label, so "ERR" is also single-sourced. */
export const STATUS_CLASS_LABEL: Record<HttpStatusClass, string>;
```

**Every input needs a stated answer, including the ones nobody thinks about.**
The current inline branches all end in a bare `else` that funnels *everything*
unmatched into the server-error colour — so `httpStatusClass(101)` would today
paint a `101 Switching Protocols` as red. The rules:

| input | class | why |
|---|---|---|
| `200`–`299` | `success` | |
| `300`–`399` | `redirect` | |
| `400`–`499` | `client-error` | |
| `500`–`599` | `server-error` | |
| `100`–`199` | `redirect` | Not a final answer — something else follows, which is the same thing a 3xx says. Grouping them is coherent; painting a `101` red is not. |
| `0` | `no-response` | |
| `NaN`, negative, `≥ 600` | `no-response` | We do not have a valid response. Never falls through to an error colour. |

**Every value is a complete literal string, not composed from a stem.** This
matters for two independent reasons.

*Tailwind would silently drop composed classes.* There is no `@source inline(…)`
directive and no safelist anywhere in `index.css` — verified, not assumed. Every
status class in the app today is written as a full literal inside a ternary or a
`cn()` call, which is why the scanner finds them. A `bg-${stem}-fill` template
would produce no CSS at all, and the failure mode is a silently uncoloured
element, most likely noticed only in a production build. This branch has already
shipped one bug of exactly that shape (`src="/icon.png"`, which worked in dev
and broke when packaged).

*Naming the key by surface role prevents the tier bug.* CLAUDE.md calls using a
bare fill as a foreground "the most common colour bug here". A caller writing
`STATUS_CLASS_STYLE[c].fill` where they want text has to actively pick the wrong
word, rather than mis-assemble a string.

## Adoption

| Site | Change |
|---|---|
| `ResponseViewer/ResponseHeader.tsx` | Use the shared badge (below). |
| `shared/response-viewer/UnifiedResponseViewer.tsx` | Use the shared badge; regains the `status === 0` → `ERR` case it lost. |
| `dashboard/…/StatusCodesOverTimeChart.tsx` | Routes its series through `httpStatusClass` instead of hardcoded labels. **Keeps its own palette** (`ROLE_TOKEN` → `--success` / `--chart-3` / `--warning` / `--destructive` / `--muted-foreground`), so no pixel changes. Only the classification is shared. |
| `history/…/OverviewTab.tsx` | Raw palette → `STATUS_CLASS_STYLE[c].tint` + `.text`. Gains a distinct no-response tile, so a 5xx and a failed connection stop looking identical. |
| `dashboard/…/RequestResponseView.tsx` | `status-running-text` → `status-redirect-text`; `warning-text` → `status-warning-text`. |

The two badges collapse into one `StatusCodeBadge` in
`components/shared/response-viewer/`. They are the same twelve lines with one
behavioural difference, and that difference is the bug.

`RequestResponseView.getStatusBadgeVariant` maps to shadcn Badge *variants*
(`default`/`secondary`/`destructive`), not colours. Left alone — it is a
different axis and folding it in would overreach.

## Guards

1. **`http-status-vocabulary.test.ts`** — scans components for a hand-rolled
   status branch (`startsWith("2")`, `>= 300 &&`, `status === 0`) paired with a
   colour class, the way `load-test` vocabulary is guarded. Must assert the scan
   set is non-empty first: vitest stubs CSS imports to `""`, and a guard that
   scanned nothing passed for weeks on this branch already.
2. **Contrast assertions** for all eleven new values, parsed out of `index.css`
   rather than hardcoded, matching the existing token tests. Include the
   completed `status-warning` triad, since amber is the tier most likely to be
   "brightened" later by someone who has not measured it.
3. **Separation assertion** — the five indicator values stay ≥0.10 apart in
   OKLab, so a future tweak to one cannot silently collide with another. Current
   worst pair is warning/no-response at 0.144.
4. **Every input has an answer** — a table-driven unit test on `httpStatusClass`
   pinning all seven rows above, including `101`, `NaN`, `-1` and `600`. The two
   that matter: `0` is not a server error (the case the duplicated badge got
   wrong and the tiles still conflate), and nothing falls through to an error
   colour by default.
5. **Literal-class assertion** — `STATUS_CLASS_STYLE` contains no template
   literals or concatenation, so nobody can refactor it into something Tailwind
   cannot see. Scans the module source and asserts it read a non-empty file.
6. Every behavioural guard **mutation-checked**: revert the fix, confirm the test
   fails, restore.

## Docs

- `docs/design-system.md` — the HTTP-severity table changes to the new mapping,
  and the two new token triads plus the completed `status-warning` triad are
  documented beside the existing ones.
  `design-system-doc.test.ts` asserts quoted `--token: H S% L%` values match
  `index.css`, so the values are checked automatically; **the prose around them
  is not** and must be read.
  The doc's status-token section currently describes a set of *four* families;
  it becomes six, and the sentence explaining why indicators are mode-consistent
  needs the amber exception noted — `--status-warning` is the one indicator that
  could not follow the `-500` convention.
  Record plainly that this table was corrected once already on this branch and is
  now being corrected again, with the ΔE numbers as the reason — otherwise the
  next reader flips it back.
- The "Decorative categorical palettes" section currently names "the history
  overview tiles" as legitimately raw palette. That was over-applied: those tiles
  encode HTTP severity, which is state, not categorical identity. Remove the
  tiles from that carve-out; **timing phases stay**.

## Out of scope

Each is a separate decision, deliberately not bundled:

- **Timing phases** (`TimingBreakdown.tsx`) stay raw palette. The design doc's
  decorative-palette carve-out genuinely applies — DNS/connect/TLS/TTFB/download
  are categorical identity, not state, and they are proper `light dark:` pairs.
- **Settings banners** (`SettingsMain.tsx`) stay amber. `--warning` and
  `--warning-text` already exist, so converting them is a small independent
  change — plausibly `Callout severity="warning"`, since the unsaved-changes
  banner is exactly that shape.
- **`--info`** stays as-is. It is `199 89% 48%` in *both* themes — the same
  theme-blind defect `--input` had — and has no `-text` variant. It also has
  **zero component uses**; only the chart layer reads it. Worth fixing, but it is
  not this change.

## Risks

- **Tailwind JIT.** Mitigated by design — `STATUS_CLASS_STYLE` holds complete
  literals — but the guard in (5) below is what keeps it that way, since a later
  edit "tidying" the map into template literals would compile fine and produce no
  CSS. Verify once in a production build, not just dev.
- **`design-system-doc.test.ts` will fail loudly** until the doc is updated in
  the same commit. That is the intended behaviour, not a surprise.
- **The doc table flip-flop** is the reputational risk: it was corrected once
  this branch. Recording the measurements inline is the mitigation.
