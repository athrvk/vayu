# Vayu Design System

> Reference for all UI tokens, component patterns, and visual conventions.
> Future sessions must read this before touching any UI file.

---

## Philosophy

**3-level elevation** — every surface sits on one of three layers. Nothing floats outside this hierarchy.

| Level | Token | Dark | Light |
|-------|-------|------|-------|
| Canvas (outermost) | `bg-background` | `#09090b` | `#f4f4f5` |
| Panel (sidebar/header/toolbar) | `bg-panel` | `#111113` | `#fafafa` |
| Card (content surface) | `bg-card` | `#1a1a1f` | `#ffffff` |

**`--tab-active`** is a fourth, single-purpose surface for the active tab. It
exists because the elevation model inverts between themes: in dark, `background`
is *below* `panel`, so an active tab matching the content pane reads darker than
the bar — correct. In light, `background` (96%) is *lighter-adjacent* to `panel`
(98%), so the same rule gave only ΔL\* 2.06 of separation and put the active tab
on the wrong side of the convention (active tabs are normally the lightest thing
in light UIs). `--tab-active` deepens it to ΔL\* 4.82 in light and stays equal to
`--background` in dark, where nothing needed fixing.

The active tab also carries a `border-t-2 border-t-primary` stripe. That is the
*primary* signal, because it reads identically in both themes, where a surface
shift does not. Inactive tabs carry `border-t-2 border-t-transparent` so the
stripe does not displace their contents by 2px.

**Paper White light mode** — light surfaces use a cool near-neutral (zinc) family; higher surfaces are lighter (canvas → panel → white card).  
**Dark canvas** — dark mode uses near-black with subtle violet undertones (zinc-950 family).

---

## CSS Custom Properties

All tokens live in `app/src/index.css` as HSL channel values (no `hsl()` wrapper — `@theme inline` and Tailwind config add that). Separate light and dark values are listed where they differ.

### Elevation

```css
/* Dark */
--background: 240 10%  4%;   /* #09090b — outermost canvas */
--panel:      240  6%  7%;   /* #111113 — sidebar / panel bg */
--card:       240  6% 11%;   /* #1a1a1f — elevated surface */

/* Light */
--background: 240  6% 96%;  /* #f4f4f5 — paper-white canvas */
--panel:      240  5% 98%;  /* #fafafa — panel */
--card:         0  0% 100%; /* #ffffff — white card */
```

### Foreground Scale

```css
/* Dark */
--foreground:         240  5% 96%;   /* #f4f4f5 — primary text */
--muted-foreground:   240  5% 65%;   /* #a1a1aa — secondary / labels */
--subtle-foreground:  240  4% 44%;   /* de-emphasized text — faintest readable tier */

/* Light */
--foreground:         240  6% 10%;   /* #18181b — primary text */
--muted-foreground:   240  4% 46%;   /* #71717a — secondary / labels */
--subtle-foreground:  240  4% 58%;   /* de-emphasized text — faintest readable tier */
```

`subtle-foreground` is the least-prominent text tier (ancillary units, dashes,
sub-labels), tuned to stay legible (~3:1 on card) while remaining below
`muted-foreground` in emphasis.

### Interactive States

```css
/* Dark */
--accent:        240  7% 16%;   /* #26262c — hover background */
--accent-active: 240  6% 21%;   /* #323238 — selected / active background */

/* Light */
--accent:        240 5% 93%;   /* #ededef — hover background */
--accent-active: 240 5% 88%;   /* #e0e0e4 — selected / active background */
```

### Borders

```css
/* Dark */
--border:        0  0% 10%;   /* ≈ rgba(255,255,255,0.07) — default dividers */
--border-strong: 0  0% 18%;   /* ≈ rgba(255,255,255,0.15) — prominent borders */

/* Light */
--border:       240  6% 89%;   /* #e2e2e5 — default dividers */
--border-strong: 240 5% 82%;   /* #cfcfd5 — prominent borders */
```

### Primary (Accent Color)

Default is Sunset orange. Overridden by `[data-color-scheme]` attribute. The
accent is **split into two tokens** to resolve a contrast bind:

- **`--primary`** — the accent used for text, borders, rings, tints, indicators
  (`text-primary`, `border-primary`, `bg-primary/10`). Mode-adaptive: deep on
  the light card, brightened on the near-black dark canvas so it reads in both.
- **`--primary-fill`** — solid button/badge backgrounds that carry a white
  label (`bg-primary-fill`). Kept deep in **both** modes so white text clears
  AA-large (a brightened dark accent would fail white-on-fill).

Rule: white-labelled solid fills use `bg-primary-fill`; everything else accent
uses `--primary`. `--primary-foreground` (white) sits on the fill.

```css
/* Sunset (default) */
--primary:       24 90% 46%;   /* light — deep accent */    /* dark: 24 95% 58% (brighter) */
--primary-fill:  24 90% 46%;   /* both modes — white-safe button fill */
--primary-foreground: 0 0% 100%;
--ring / --variable: track --primary
```

### Semantic Status Colors

These differ between light and dark mode.

```css
/* Light */
--success:            142 76% 36%;   /* green */
--warning:             38 92% 50%;   /* amber */
--info:               199 89% 48%;   /* cyan */
--destructive:          0 84% 60%;   /* red */

/* Dark */
--success:            142 70% 45%;   /* lighter green */
--warning:             38 92% 50%;   /* same */
--info:               199 89% 48%;   /* same */
--destructive:          0 62.8% 30.6%;  /* darker red */
```

**`-text` variants for legible text.** The base `--success` / `--warning` /
`--destructive` tokens are tuned as *fills and indicators*; as small text on a
light surface they fall below AA. Use the darkened (light) / lightened (dark)
`-text` variant when the color is the text itself — `text-success-text`,
`text-warning-text`, `text-destructive-text` — keeping `bg-*` / `border-*`
fills on the base token.

```css
/* Light — accessible text on light surfaces */
--success-text:  142 72% 30%;   --warning-text:  38 90% 35%;   --destructive-text: 0 60% 48%;
/* Dark — accessible text on dark surfaces */
--success-text:  142 60% 55%;   --warning-text:  40 92% 60%;   --destructive-text: 0 65% 63%;
```

### Variable Scope Colors (Categorical)

Variable scopes use a **categorical** palette (not semantic status): a distinct
hue per scope, mode-adaptive so it reads on both light and dark surfaces. Used
as text/icon/border at full strength and as tinted backgrounds via opacity.

```css
/* Light */
--scope-global:      142 72% 29%;   /* green-700 */
--scope-collection:   21 90% 42%;   /* orange-700 */
--scope-environment: 217 91% 45%;   /* blue-600 */

/* Dark */
--scope-global:      142 69% 58%;   /* green-400 */
--scope-collection:   27 96% 61%;   /* orange-400 */
--scope-environment: 213 94% 68%;   /* blue-400 */
```

**Utility classes** (`text-`, `bg-`, `border-`, `ring-`, `accent-`):
`text-scope-global`, `bg-scope-collection/10`, `border-scope-environment/20`, …

| Scope | Token | Convention |
|-------|-------|-----------|
| Global | `scope-global` | icon/text solid; `bg-scope-global/10` tint |
| Collection | `scope-collection` | icon/text solid; `bg-scope-collection/10` tint |
| Environment | `scope-environment` | icon/text solid; `bg-scope-environment/10` tint |

Never hardcode `bg-green-50 dark:bg-green-950` pairs for scopes — use the token
at an opacity (`/10` background, `/20`–`/30` border, full for text/icon).

### Run / Status Indicator Colors

Run, connection, and test status (dots, left-bars, pills, status icons) use a
cohesive `--status-*` set. Unlike everything else, these are **mode-consistent**
— the same value in light and dark — because a status dot should read as the
same "good / bad / busy" signal on either surface. Distinct from `--success` /
`--destructive`, which are tuned for banner text and button fills respectively.

```css
--status-success: 142 71% 45%;   /* green-500  — completed / connected / pass */
--status-error:   0 84% 60%;     /* red-500    — failed / test fail */
--status-running: 217 91% 60%;   /* blue-500   — running */
--status-stopped: 25 95% 53%;    /* orange-500 — stopped */
/* pending → text-muted-foreground / bg-muted-foreground */
```

**Utility classes** (`text-`, `bg-`, `border-`): `text-status-success`,
`bg-status-error`, `border-status-running/25`, etc. Use `--warning` for
"expiring / caution" indicators (amber) and `--success` for success *banners*.

The same set also colors **HTTP response severity** (2xx → `status-success`,
3xx → `status-running`, 4xx → `warning`, 5xx/0 → `status-error`) and **latency
thresholds** (normal → `status-running`, slow → `status-stopped`, danger →
`status-error`), since those map onto the same hues.

### Decorative categorical palettes (the one token exception)

A few surfaces use a **fixed decorative palette** to give items a stable
identity by color rather than to signal state — the same idea as `--chart-*`.
These intentionally keep Tailwind hue utilities (with `dark:` variants) instead
of tokens, because they never respond to theme and don't carry semantics:

- **Settings sections** — per-section accent (pink/blue/amber/cyan/purple/green).
- **Timing phases** — DNS / connect / TLS / TTFB / download in the breakdown.
- **Console sections** — Pre-request (blue) vs Test (green) script groups; the
  console body is a deliberately dark terminal (`zinc-900`) in both modes.

Everything else — state, status, scope, semantics — must use tokens.

### HTTP Method Color Tokens

**Always render methods with `MethodBadge`** (`components/shared`) — never a
hand-rolled span or `Badge` with inline colours. It previously rendered seven
different ways (three sizes, two weights, some tinted, two with no colour at
all), and the history sidebar kept a private copy of the colour logic that
omitted `getMethodColor`'s fallback, so an unrecognised method silently lost its
colour.

```tsx
<MethodBadge method={request.method} />                        // tinted chip, 10px
<MethodBadge method={request.method} size="md" />              // 11px, beside body text
<MethodBadge method={request.method} variant="text" />         // colour only, dense rows
<MethodBadge method={m} variant="text" muted={!isActive} />    // secondary context
```


Method colors are design tokens defined in `:root`, not hardcoded hex values. They are consistent between light and dark mode.

```css
--method-get:     142 76% 36%;   /* green */
--method-post:    217 91% 60%;   /* blue */
--method-put:      38 92% 50%;   /* amber */
--method-patch:   262 83% 58%;   /* purple */
--method-delete:    0 84% 60%;   /* red */
--method-head:    199 89% 48%;   /* cyan */
--method-options: 240  5% 64%;   /* gray */
```

**Utility classes** (defined in `index.css`, available as Tailwind class names):
- Text color: `.method-get`, `.method-post`, `.method-put`, `.method-patch`, `.method-delete`, `.method-head`, `.method-options`
- Background: `.bg-method-get`, `.bg-method-post`, etc.

**`getMethodColor(method)`** in `app/src/utils/helpers.ts` returns `var(--method-xxx)` — the raw CSS variable reference. Callers construct full color values:

```tsx
const c = getMethodColor(method); // e.g. "var(--method-get)"

// Solid color (text, stroke):
color: `hsl(${c})`

// Tinted background (~10% opacity):
background: `hsl(${c} / 0.1)`

// Tinted border (~30% opacity):
borderColor: `hsl(${c} / 0.3)`
```

**Method badge pattern** (inline `<span>`, not a `<Badge>` component — used in RunItem, DashboardHeader):

```tsx
const c = `var(--method-${method.toLowerCase()})`;
<span
  className="text-[10px] h-5 px-1.5 font-mono font-bold shrink-0 inline-flex items-center rounded"
  style={{
    color:      `hsl(${c})`,
    background: `hsl(${c} / 0.1)`,
    border:     `1px solid hsl(${c} / 0.3)`,
  }}
>
  {method}
</span>
```

**MethodSelector** uses the `.method-get` etc. utility classes as Tailwind classNames:

```tsx
const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: "method-get", POST: "method-post", PUT: "method-put",
  PATCH: "method-patch", DELETE: "method-delete", HEAD: "method-head", OPTIONS: "method-options",
};
// Usage: className={cn("font-mono font-semibold", METHOD_COLORS[method])}
```

### Charts

A cohesive categorical set — `chart-1` tracks the active accent, then four
evenly-spaced hues (teal / violet / amber / rose) shared across modes and tuned
only in lightness for each ground.

```css
/* Light */
--chart-1: <accent>;         /* tracks --primary */
--chart-2: 172 66% 38%;   /* teal */
--chart-3: 258 55% 55%;   /* violet */
--chart-4:  38 88% 48%;   /* amber */
--chart-5: 340 72% 50%;   /* rose */

/* Dark — same hues, lifted for the dark ground */
--chart-1: <accent>;
--chart-2: 172 60% 52%;
--chart-3: 258 78% 72%;
--chart-4:  38 90% 60%;
--chart-5: 340 74% 62%;
```

---

## Color Schemes (Accent Themes)

Applied via `data-color-scheme` attribute on `<html>`. Each scheme sets
`--primary`, `--primary-fill`, `--primary-foreground`, `--ring`, `--variable`,
and `--chart-1`. The authoritative per-scheme values (deep fill + mode-adaptive
accent) live in `app/src/index.css`; the table below is an approximate guide.

| Scheme | Light HSL | Dark HSL |
|--------|-----------|----------|
| `sunset` (default) | `24.6 95% 53.1%` | same |
| `sky` | `188 94% 43%` | same |
| `ocean` | `217 91% 60%` | `217 78% 51%` |
| `forest` | `142 76% 36%` | `142 70% 45%` |
| `aurora` | `258 87% 74%` | same |
| `coral` | `0 72% 65%` | `0 72% 55%` |

---

## Typography

### Fonts

| Role | Family | Import |
|------|--------|--------|
| UI / body | Space Grotesk | Google Fonts |
| Code / mono | JetBrains Mono | Google Fonts |

```html
<!-- app/index.html -->
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
```

```css
body { font-family: var(--font-sans); } /* default: "Space Grotesk", system-ui, sans-serif */
/* mono via font-mono Tailwind class, or .font-code utility */
```

**User-selectable UI font + scale.** Settings → Appearance → Interface lets the
user pick the sans/body face (Space Grotesk / Inter / System / JetBrains Mono)
and an interface scale (Compact / Default / Comfortable). Font swaps the `--font-sans`
custom property (so `body` + every `font-sans` utility follow); scale sets the
page zoom factor (Electron `webFrame`, CSS `zoom` fallback in the browser).
Both are owned by `useAppearance` (source of truth `constants/appearance.ts`),
persisted to localStorage, and applied pre-paint in `index.html`. Code/mono
text stays JetBrains Mono regardless.

### Type Scale Conventions

| Use | Size | Weight | Class |
|-----|------|--------|-------|
| Section label / eyebrow | 11px | semibold, uppercase, +tracking | `text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground` |
| Hero metric value | 34px | bold, tabular | `text-[34px] font-bold leading-none font-mono tabular-nums` |
| Secondary metric value | 22px | bold | `text-[22px] font-bold font-mono` |
| Body / default | 13px | regular | `text-sm` |
| Small label | 12px | medium | `text-[12px] font-medium` |
| Micro / badge | 10–11px | mono bold | `text-[10px] font-mono font-bold` |
| URL / path | 12–13px | mono | `text-[12px] font-mono` |

**Use `text-sm` for body, not `text-[13px]`.** Tailwind ships `text-sm` at 14px,
which left the app running two scales a pixel apart — `text-sm` in ~160 places
against `text-[13px]` in ~18. Rather than migrate every call site, `--text-sm` is
redefined in `@theme` (`index.css`) to **13px/18px**, so the utility *is* the
documented body size. `text-xs` already matches the 12px label, so that was the
only size that diverged. `text-[13px]` still works but skips the paired
line-height — prefer `text-sm`.

**Icon sizing goes on `className`, not lucide's `size` prop.** Mixing the two
hides icons from a scale audit and lets off-grid values (15px) creep in. Use
`w-3 h-3` (12), `w-3.5 h-3.5` (14), `w-4 h-4` (16), `w-5 h-5` (20).

---

## Geometry

```css
--radius: 0.375rem;   /* 6px — base border radius (default) */
```

| Class | Value |
|-------|-------|
| `rounded-sm` | `calc(var(--radius) - 4px)` |
| `rounded-md` | `calc(var(--radius) - 2px)` |
| `rounded-lg` | `var(--radius)` |
| `rounded-full` | pill / circle |

**User-adjustable.** Settings → Appearance → Interface → Roundedness sets
`--radius` (Square `0rem` / Default `0.375rem` / Rounded `0.75rem`), owned by
`useAppearance`, persisted, applied pre-paint. So `rounded-sm/md/lg` reshape
live. **Always use `rounded-md`/`rounded-lg`/`rounded-sm`, never Tailwind's
unsuffixed `rounded`** (fixed 4px — it ignores `--radius` and won't follow the
control). `rounded-full` stays a pill regardless.

Cards and panels use `rounded-md`. Badges/chips use `rounded-sm`. Status pills
use `rounded-full`.

**`rounded-full` is for non-interactive indicators only** — status dots, status
pills, spinners, circular icon wells, colour swatches. Because it ignores
`--radius` by design, using it on a control (a button, a dropdown trigger) makes
that control the one thing on screen that does not respond to the Roundedness
setting. Interactive elements take `rounded-md`/`rounded-sm`.

---

## Animations

Defined in both `index.css` and `tailwind.config.js`. All three `vayu-*` animations have Tailwind shorthand aliases (`animate-vayu-spin`, `animate-vayu-pulse`, `animate-vayu-fadepulse`) in addition to the verbose arbitrary form.

| Name | Duration | Curve | Tailwind class | Use |
|------|----------|-------|----------------|-----|
| `vayu-spin` | 0.7s | linear | `animate-vayu-spin` | Loading spinners |
| `vayu-pulse` | 1.6s | ease-in-out | `animate-vayu-pulse` | Live indicators (100→35% opacity) |
| `vayu-fadepulse` | 2s | ease-in-out | `animate-vayu-fadepulse` | Subtle breathe (90→50% opacity) |
| `accordion-down/up` | 0.2s | ease-out | `animate-accordion-down/up` | Radix accordion |
| `fade-in` | 0.2s | ease-out | `animate-fade-in` | General reveal |
| `slide-in` | 0.2s | ease-out | `animate-slide-in` | Dropdown/panel entry |
| interaction state | 0.15s | ease | *(baseline in `index.css`)* | Hover/active colour changes on interactive elements |

**Spinner pattern:**
```tsx
<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-vayu-spin inline-block" />
```

**Live dot pattern:**
```tsx
<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
```

---

## Focus & Interaction States

Interactive elements get a keyboard focus ring and hover transition from a
baseline in `app/src/index.css` (`@layer base`) — **do not add per-component
focus classes for the default case.**

```css
:where(button, [role="button"], a[href], input, select, textarea, summary,
       [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 1px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

- `:where()` keeps specificity at **0**, so any component utility overrides it
  without `!important`. The `components/ui/*` primitives already carry their own
  `focus-visible:ring` and keep their appearance.
- `:focus-visible` fires only on keyboard/AT focus — mouse users never see a ring.
- **1px, not 2px.** On dense lists and toolbars a hairline reads as considered;
  a 2px saturated rectangle reads as a browser default.
- `outline` follows the **element's own** `border-radius`. That means the
  roundedness setting governs the ring **only on elements that already carry a
  `rounded-*` class**. An element with no radius gets a square ring at every
  setting — so if a ring should reshape with the control, put the indicator on an
  element that has the radius (see below).
- Transitions list paint properties explicitly (`background-color`, `color`,
  `border-color`, `opacity`) at **150ms**. Never `transition: all` — it can
  animate layout properties. Reduced motion already collapses these app-wide.

**Clipping panels.** An element whose `overflow-*` would cut off an outset ring
must carry `.panel-clip`; every focusable descendant then gets
`outline-offset: -1px`. Currently on the `TabStrip` row and the `Drawer` content
wrapper. Put it on the element carrying the overflow — not on the rows. For a
one-off outside such a container, use the `.focus-ring-inset` utility.

**Composite rows — `.focus-row`.** The baseline attaches the ring to whatever is
*focusable*, which is only right when the focusable element is also what the user
reads as the target. In a tree row it often isn't: a collection row is 220px with
a rounded hover fill, but its label button is 150px with square corners, so an
outline on the button indicates the wrong shape in the wrong place.

Put `.focus-row` on the element that paints the hover background. It then draws
the indicator itself — at its own radius, so the roundedness control governs it —
and adds the same accent fill hover uses, which is how native list selection
reads. The inner control draws nothing.

```css
:where(.focus-row):has(:focus-visible:not(.focus-self)) {
  outline: 2px solid hsl(var(--primary) / 0.3);
  outline-offset: -2px;
}
.focus-row :focus-visible:not(.focus-self) { outline: none; }
```

The indicator mirrors the disclosure chevron's own ring (`ring-2
ring-primary/30`) and the selected-row ring (`ring-1 ring-inset
ring-primary/20`) so focus, selection and hover speak one language. It uses
`outline` rather than `box-shadow` because Tailwind's ring utilities own
`box-shadow` — a selected row already sets one, which would override it.

**Auxiliary controls opt out with `.focus-self`.** A control inside the row that
is its own target — the chevron toggles expansion rather than opening the
collection — keeps its own ring and does not light the row, so exactly one
indicator ever shows.

`.focus-row` covers two cases: the row is itself focusable (the collection tree's
roving tabindex focuses the row), or focus sits on a control inside it. `:has()`
is descendant-only and does not cover the first, hence the `:focus-visible`
selector alongside it.

---

## Row Actions

Controls that appear on a row you are already hovering — `⋯`, delete, remove.

**Never use `ghost` for these.** `ghost` hovers to `bg-accent`, which is exactly
what the row underneath already paints, so the button looks like it has no hover
state at all. Use the dedicated variants, which step up to `accent-active`:

| Variant | Use | Hover |
|---------|-----|-------|
| `rowAction` | neutral (`⋯`, edit, copy) | `bg-accent-active` + `text-foreground` |
| `rowActionDestructive` | delete / remove | `bg-accent-active` + `text-destructive` |

Destructive rows share the neutral shape and differ **only** in glyph colour on
hover. No red background tint: the row already carries one fill, a second
competing tint is noise, and `DeleteConfirmDialog` is what actually protects the
user — the red glyph only needs to signal at the point of intent.

Reveal them with `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
The `focus-within` half is not optional: without it a keyboard user lands on an
invisible control.

**Prefer `RowActionsMenu`** (`components/shared`) over adding another inline icon
button. It renders the `⋯` trigger plus a `DropdownMenu`, so rows expose actions
consistently and get focus management, Escape-to-close and arrow-key navigation
for free. Used by request rows and environment rows.

---

## Drawer Panel Frame

**Every drawer view renders inside `DrawerPanel`** (`components/shared`). It owns
the header (title + trailing actions) and the scroll region; views supply only
their content.

The four views had drifted into two different panel designs — Collections and
History used a 16px padded container with a heading, Variables and Settings were
flush with no heading at all. Switching views moved the content's vertical start
*and* made the title appear or vanish. All four now match exactly: heading at
11px from the panel top, body at 40px.

- **The frame owns header padding; the body is flush.** Rows run edge to edge —
  the sidebar convention, and it recovers the ~32px of row width the old inset
  cost. Rows bring their own internal padding.
- **Full-bleed rows are square.** A rounded corner meeting the panel edge reads
  as a clipped rectangle, not a rounded row.
- **The panel owns scrolling** — vertically only. Views used to differ: some were
  wrapped in a `ScrollArea` by the Drawer, others managed their own.
- **Indent with padding inside the row, never margin around it.** Margin pushes
  the row's _background_ in too, so a nested row's hover and selection fill stops
  short of the panel edge while a top-level row's reaches it. Depth is shown by
  where the content sits, not where the row starts:
  `paddingLeft: 8 + depth * INDENT_STEP` (`constants/layout`).
- **A row must never widen the panel.** Long names ellipse; the drawer has no
  horizontal scrollbar. `truncate` alone is not enough when the text sits inside
  a `flex-1` _wrapper_ — a flex item will not shrink below its content width, so
  the wrapper needs `min-w-0` as well. (A `truncate` element that is itself the
  flex item is fine: `overflow: hidden` already gives it an automatic minimum
  size of 0.) Short trailing metadata — counts, badges, spinners — takes
  `shrink-0`, so the name is what yields.

---

## Drawer Row Metric

**Single-line drawer rows are `h-8` (32px).** State the height; do not let it
fall out of the content. It previously did — a 28px chevron set the collection
row, padding set the others — so the four drawer views ran **34 / 36 / 38 / 40px**
and the rhythm shifted every time the user switched view, one click apart in the
same panel. Collection and request rows differed by 4px inside a *single* tree.

Applies to `CollectionItem`, `RequestItem`, `SettingsCategoryTree` and
`VariablesCategoryTree` rows. Put `h-8 items-center` on the row and let content
centre; do not re-add vertical padding, which is what caused the drift.

Section *headers* (e.g. "Environments") stay shorter on purpose — they are group
labels, not list items, and the difference carries hierarchy.

The disclosure chevron is `w-6 h-6` (24px) so it fits a 32px row. That is still
an adequate pointer target, and the whole row remains clickable for opening.

---

## Overflowing Text

User-supplied names — collections, requests, environments, URLs — are unbounded,
so every surface that shows one needs a defined overflow behaviour. There are
exactly **two**, and they are not interchangeable:

| Treatment          | Component          | Where                                 |
| ------------------ | ------------------ | ------------------------------------- |
| Ellipsis + tooltip | `TruncatedText`    | Rows, headers, pickers — the default. |
| Marquee on hover   | `ScrollOnOverflow` | Tab strip only.                       |

**`TruncatedText` is the default.** It ellipses, and reveals the full value in a
native `title` tooltip **only while the text is actually clipped**. An
unconditional `title={name}` — the obvious version — pops a tooltip on every
hover, including names that are already fully readable, telling the user
something they can see. The tooltip appears when the name is cut off and
disappears when the drawer is widened enough to read it; `useOverflowTitle`
re-measures on resize via `ResizeObserver`.

Do not hand-write `title={name}` alongside `truncate`. That is the pattern this
component replaced, and it drifts — some rows get it, some do not, and the ones
that do show it unconditionally.

**`ScrollOnOverflow` marquees instead**, and is limited to the tab strip, where
the label is the primary target and there is no way to widen it. Rows must not
animate under the cursor.

Text that **wraps** (`break-words`, e.g. the run URL in `RunItem`) is neither —
it never clips, so it needs no tooltip.

---

## Tree Navigation (roving tabindex)

The collection tree follows the WAI-ARIA treeview pattern: **the whole tree is
one tab stop**. Previously every row and every control in it was a stop — a
workspace with 2 collections and 4 requests cost 17 presses to tab past.

- Container: `role="tree"`. Rows: `role="treeitem"`, `aria-expanded` on
  collections, `aria-selected` for the open entity.
- Rows render `tabIndex={-1}`; `useRovingTreeFocus` promotes exactly one to `0`.
- Keys: Up/Down move, Home/End jump, Right expands then steps in, Left collapses
  then moves to the parent, Enter/Space opens, **Delete** deletes, **Shift+F10 /
  Menu** opens row actions.
- Every control inside a row is `tabIndex={-1}`, so Delete and Shift+F10 are the
  keyboard path to row actions — do not remove them without providing another.

Rows declare behaviour through data attributes rather than props
(`data-tree-activate`, `data-tree-toggle`, `data-tree-menu`, `data-tree-delete`),
so the hook needs nothing threaded through `CollectionItem`'s prop list.

**Focus is not selection.** Arrows move focus without opening anything; Enter
opens. Keep roving focus, `aria-selected`, and the open tab in tabs-store
distinct — conflating them is the classic treeview bug.

Visible order comes from the DOM (`[role="treeitem"]` in document order), since
collapsed subtrees are not rendered. Note a row's children are a **sibling** of
that row inside a shared wrapper, not nested within it, so finding a parent row
means walking up to the enclosing wrapper — not `closest()`.

Currently on `CollectionItem` and `RequestItem` rows. **Only needed where the
control and the row genuinely differ** — the history, variables and settings
trees use full-width buttons that are their own target, so they use the baseline.
Before adding it, check whether the focusable element already spans the row.

---

## Layout Structure

```
Shell
├── Resizable sidebar container  (280–600px, default 320px — useResizable hook)
│   └── Sidebar
│       ├── ActivityBar     w-11 (44px)  bg-panel border-r border-border
│       └── SidebarPanel    w-60 (240px) bg-panel border-r border-border  (collapsible)
├── Resize handle            w-1  bg-border hover:bg-primary cursor-col-resize
└── main (flex-1)            routes render here
```

### Resizable Sidebar

Shell uses `useResizable` from `app/src/hooks/useResizable.ts`:

```tsx
const { size: sidebarWidth, isResizing, startResizing } = useResizable({
  defaultSize: 320,
  min: 280,
  max: 600,
});

// Sidebar container:
<div style={{ width: `${sidebarWidth}px`, minWidth: "280px", maxWidth: "600px" }} className="flex-shrink-0 ...">
  <Sidebar />
</div>

// Drag handle:
<div
  onMouseDown={startResizing}
  className={cn("w-1 bg-border hover:bg-primary cursor-col-resize transition-colors shrink-0", isResizing && "bg-primary")}
/>
```

**`useResizable` API:**

```ts
useResizable({ defaultSize, min, max, direction?: "horizontal" | "vertical" })
// → { size: number, isResizing: boolean, startResizing: (e: React.MouseEvent) => void }
```

`startResizing` takes a `React.MouseEvent` (wire directly to `onMouseDown`). Uses delta-based calculation — captures drag origin on mousedown, computes `newSize = startSize + delta` — so it works for panels that don't start at the viewport origin.

### ActivityBar

- **Width:** `w-11` (44px), full height, `bg-panel border-r border-border`
- **Tab buttons:** `w-10 h-10 flex items-center justify-center rounded-md`
- **Active state:** `bg-primary/10 text-primary` + 2px left accent bar
  ```tsx
  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-sm" />
  ```
- **Inactive hover:** `hover:bg-accent hover:text-foreground`
- **Icon size:** `w-4 h-4`
- **Tabs (top):** Collections (Folder), History (Clock), Variables (Code2)
- **Tab (bottom, pinned):** Settings (Settings2) — pushed down with `flex-1` spacer
- **Collapse:** clicking active tab while panel open → `setPanelOpen(false)`
- **Tooltips:** `side="right"` via `TooltipContent`

### SidebarPanel

- **Width:** `w-60` (240px) internal — the outer resizable container starts at 320px
- `bg-panel border-r border-border overflow-hidden`
- **Content:** `ScrollArea` fills available space
- **Footer:** `ConnectionStatus` pinned to bottom with `border-t border-border`

---

## Component Patterns

### Cards

```tsx
<div className="bg-card border border-border rounded-md p-4">
  ...
</div>
```

Never use hardcoded background colors like `bg-gray-50`, `bg-blue-50`, `bg-zinc-900` for card surfaces. Always `bg-card`.

### Section Eyebrow Label

```tsx
<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-4">
  Section Title
</p>
```

### Status Badges / Pills

**Live (running):**
```tsx
<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-green-500/15 text-green-500 border border-green-500/25">
  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
  LIVE
</span>
```

**Completed / Stopped:**
```tsx
<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border">
  COMPLETED
</span>
```

**Run status left-bar (RunItem):**
```tsx
<div className={cn(
  "absolute left-0 top-0 bottom-0 w-1",
  status === "completed" && "bg-green-500",
  status === "failed"    && "bg-red-500",
  status === "running"   && "bg-blue-500",
  status === "stopped"   && "bg-orange-500",
  status === "pending"   && "bg-muted-foreground"
)} />
```

### Destructive Actions

```tsx
/* Error/warning banner */
<div className="bg-destructive/10 text-destructive rounded-md p-3">...</div>

/* Stop button */
<Button
  variant="ghost"
  className="text-destructive hover:bg-destructive/10 hover:text-destructive border border-destructive/30"
>
  Stop
</Button>

/* Delete icon button */
<Button
  variant="ghost"
  size="icon"
  className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100"
>
  <Trash2 className="w-3 h-3" />
</Button>
```

### URL Bar (Flat Style)

```tsx
<div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-panel shrink-0">
  <MethodSelector />   {/* w-[76px] h-[34px] bg-accent font-mono font-bold text-[11px] */}
  <UrlInput className="flex-1 h-[34px] bg-card border border-border rounded-md px-3 text-[13px] font-mono focus:border-primary focus:outline-none transition-colors" />

  {/* Primary action */}
  <button className="h-[34px] px-4 rounded-md bg-primary text-white text-[13px] font-semibold ...">
    {isExecuting
      ? <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-vayu-spin inline-block" /> Sending</>
      : <>▶ Send</>
    }
  </button>

  {/* Secondary action — always token-based (text-primary/border-primary/bg-primary/10), never hardcoded purple */}
  <button className="h-[34px] px-3.5 rounded-md text-[12px] font-semibold text-primary border border-primary bg-primary/10 ...">
    <Zap className="w-3.5 h-3.5" /> Load Test
  </button>
</div>
```

### Dashboard Header (Compact 52px)

```tsx
<div className="h-[52px] flex items-center gap-3 px-5 bg-panel border-b border-border shrink-0">
  {/* Status pill — LIVE (green animated dot) or COMPLETED/STOPPED (muted) */}
  {/* Method badge — inline <span> with hsl(var(--method-xxx)) inline style */}
  {/* URL — font-mono text-[12px] flex-1 truncate */}
  {/* Config summary — text-[12px] text-muted-foreground hidden sm:block */}
  {/* Stop button — ghost variant, destructive color, Loader2 spinner while stopping */}
</div>
```

The header has a live elapsed timer (`liveTick` state) that resets to 0 at the start of each run.

### SVG Sparkline

```tsx
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
  const w = 108, h = 26;
  const pts = data.map((v, i) =>
    `${(1 + (i / (data.length - 1)) * w).toFixed(1)},${(1 + h * (1 - (v - min) / rng)).toFixed(1)}`
  );
  const area = `M1,${h + 1} L${pts.join(" L")} L${w + 1},${h + 1}Z`;
  return (
    <svg width={110} height={28} className="block overflow-visible">
      <path d={area} fill={color} fillOpacity="0.15" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
```

### SVG Area Chart

`viewBox="0 0 600 150"`, padding `PL=42 PR=8 PT=6 PB=20`. Area fill uses `fillOpacity="0.12"` (slightly less than the sparkline's `0.15`). Grid lines use `hsl(var(--border))` with `strokeDasharray="2 2"`. Axis labels use `hsl(var(--muted-foreground))` in JetBrains Mono at `fontSize="9"`. Requires `data.length >= 2` (returns null otherwise).

### Hero Metric Card

```
┌─────────────────────────────────────────┐
│ LABEL (11px, uppercase, muted)          │
│ 34px bold mono value   unit (xs, muted) │
│ sub-label (11px, muted)                 │
│ [sparkline 110w] (optional, below)      │
└─────────────────────────────────────────┘
```

```tsx
<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1">
  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
  <div className="flex items-baseline gap-1.5 mt-0.5">
    <span
      className="text-[34px] font-bold leading-none font-mono tabular-nums"
      style={{ color: valueColor || "hsl(var(--foreground))" }}
    >
      {value}
    </span>
    {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
  </div>
  {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
  {sparkData && sparkData.length > 1 && (
    <div className="mt-2">
      <Sparkline data={sparkData} color={sparkColor || "hsl(var(--primary))"} />
    </div>
  )}
</div>
```

Note: sparkline renders **below** the value row, not beside it.

### Secondary Stat Card

```tsx
<div className="bg-card border border-border rounded-md p-3">
  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-1.5">{label}</p>
  <div className="flex items-baseline gap-1">
    <span className="text-[22px] font-bold font-mono text-foreground">{value}</span>
    {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
  </div>
</div>
```

### Latency Distribution Bar

Gradient track (green→amber→red at 18% opacity), with absolute-positioned needle markers at p50/p95/p99. Each marker consists of:
- A 1px-wide, 16px-tall vertical pin: `w-px h-4 mx-auto opacity-85`
- A dot below it: `w-2 h-2 rounded-full mx-auto -mt-1` with `boxShadow: "0 0 0 2px hsl(var(--card))"` (creates the ring effect without Tailwind ring classes)
- Value label + percentile label below

---

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
| Default border | `border-border` |
| Strong border | `border-border-strong` |
| Hover state | `hover:bg-accent` |
| Selected state | `bg-accent-active` |
| Success | `text-success`, `bg-success/10` |
| Warning | `text-warning`, `bg-warning/10` |
| Info | `text-info`, `bg-info/10` |
| Error | `text-destructive`, `bg-destructive/10` |
| Method text (GET) | `method-get` (and `method-post`, `method-put`, etc.) |
| Method bg (GET) | `bg-method-get` (and `bg-method-post`, etc.) |
| Mono font | `font-mono` |
| Code font (utility) | `font-code` |
| Thin scrollbar | `scrollbar-thin` |
| Variable color | `text-variable` or `.variable-highlight` |

### Never use

- `bg-gray-*`, `bg-zinc-*`, `bg-slate-*` — use `bg-card`, `bg-panel`, `bg-background`
- `bg-blue-50`, `bg-red-950`, etc. — use `bg-destructive/10`, `bg-info/10`, etc.
- `dark:bg-*` hardcoded overrides — tokens handle both modes automatically
- `text-gray-500`, `text-gray-400` — use `text-muted-foreground`
- Hardcoded hex method colors like `text-[#22c55e]` — use `method-get` or `hsl(var(--method-get))`
- `${hexColor}18` hex-alpha concatenation — use `hsl(var(--method-xxx) / 0.1)`
- Hardcoded purple for Load Test / secondary actions — use `text-primary/border-primary/bg-primary/10`

---

## Response Body Syntax Highlighting

Planned / pending implementation. Intended colors for the JSON pretty-printer:

| Token | Color |
|-------|-------|
| Object keys | `#7dd3fc` (sky-300) |
| String values | `#86efac` (green-300) |
| Number values | `#fbbf24` (amber-400) |
| Boolean values | `#a78bfa` (violet-400) |
| Null | `#94a3b8` (slate-400) |

---

## Scrollbar

All scrollable panes use `.scrollbar-thin` utility:
```css
scrollbar-width: thin;
scrollbar-color: hsl(var(--muted-foreground) / 0.3) transparent;
```

---

## Source Files

| File | Purpose |
|------|---------|
| `app/src/index.css` | All CSS custom properties, keyframes, utility classes |
| `app/tailwind.config.js` | Color mapping, font families, keyframes, animation aliases |
| `app/index.html` | Google Fonts preconnect + link tags |
| `app/src/components/layout/Shell.tsx` | Root layout — resizable sidebar + drag handle + main |
| `app/src/components/layout/Sidebar.tsx` | ActivityBar + SidebarPanel |
| `app/src/hooks/useResizable.ts` | Drag-to-resize hook (delta-based, horizontal/vertical) |
| `app/src/utils/helpers.ts` | `getMethodColor(method)` → `var(--method-xxx)` |
| `app/src/modules/dashboard/components/MetricsView.tsx` | Sparkline, SvgAreaChart, LatencyBar, HeroCard, StatCard |
