# Vayu Design System

> Reference for all UI tokens, component patterns, and visual conventions.
> Future sessions must use this doc to stay consistent with the established design language.

---

## Philosophy

**3-level elevation** — every surface sits on one of three layers. Nothing floats outside this hierarchy.

| Level | Token | Dark | Light |
|-------|-------|------|-------|
| Canvas (outermost) | `bg-background` | `#09090b` | `#e6e3dc` |
| Panel (sidebar/header/toolbar) | `bg-panel` | `#111113` | `#f2f0eb` |
| Card (content surface) | `bg-card` | `#1a1a1f` | `#ffffff` |

**Warm Stone light mode** — light surfaces use warm gray-stone tones, never cold white/gray.  
**Dark canvas** — dark mode uses near-black with subtle violet undertones (zinc-950 family).

---

## CSS Custom Properties

All tokens live in `app/src/index.css` as CSS custom properties in HSL channel format (no `hsl()` wrapper — the `@theme inline` block and Tailwind config add that).

### Elevation

```css
/* Dark mode */
--background: 240 10%  4%;   /* #09090b — outermost canvas */
--panel:      240  6%  7%;   /* #111113 — sidebar / panel bg */
--card:       240  6% 11%;   /* #1a1a1f — elevated surface */

/* Light mode */
--background: 42 17% 88%;   /* #e6e3dc — warm stone canvas */
--panel:      42 21% 94%;   /* #f2f0eb — warm panel */
--card:        0  0% 100%;  /* #ffffff — white card */
```

### Foreground Scale

```css
/* Dark */
--foreground:         240  5% 96%;   /* #f4f4f5 — primary text */
--muted-foreground:   240  5% 65%;   /* #a1a1aa — secondary / labels */
--subtle-foreground:  240  5% 34%;   /* #52525b — de-emphasized, placeholders */

/* Light */
--foreground:         240  6% 10%;   /* #18181b — primary text */
--muted-foreground:   240  4% 46%;   /* #71717a — secondary / labels */
--subtle-foreground:  240  7% 78%;   /* #c4c4cc — de-emphasized, placeholders */
```

### Interactive States

```css
/* Dark */
--accent:        240  7% 16%;   /* #26262c — hover background */
--accent-active: 240  6% 21%;   /* #323238 — selected / active background */

/* Light */
--accent:        38 20% 89%;   /* #e9e5de — hover background */
--accent-active: 40 16% 85%;   /* #dedad2 — selected / active background */
```

### Borders

```css
/* Dark */
--border:        0  0% 10%;   /* ≈ rgba(255,255,255,0.07) — default dividers */
--border-strong: 0  0% 18%;   /* ≈ rgba(255,255,255,0.15) — prominent borders */

/* Light */
--border:       40  9% 80%;   /* ≈ rgba(0,0,0,0.09) — default dividers */
--border-strong: 40  6% 72%;  /* ≈ rgba(0,0,0,0.18) — prominent borders */
```

### Primary (Accent Color)

Default is Sunset orange. Overridden by `[data-color-scheme]` attribute.

```css
--primary:            24.6 95% 53.1%;   /* #f97316 — orange-500 */
--primary-foreground:  0   0% 100%;     /* white text on primary */
--ring:               24.6 95% 53.1%;   /* focus rings */
--variable:           24.6 95% 53.1%;   /* variable highlights in URL/body */
```

### Semantic Status Colors

```css
--success:   142 76% 36%;   /* green — completed, passing */
--warning:    38 92% 50%;   /* amber — warnings, slow requests */
--info:      199 89% 48%;   /* cyan — informational */
--destructive: 0 84% 60%;   /* red — errors, stop, delete */
```

### Charts

```css
/* Dark */
--chart-1: 24.6 95% 53.1%;   /* primary (orange by default) */
--chart-2: 160  60% 45%;     /* teal */
--chart-3:  30  80% 55%;     /* amber */
--chart-4: 280  65% 60%;     /* violet */
--chart-5: 340  75% 55%;     /* rose */

/* Light — same chart-1; others differ slightly */
--chart-2: 173 58% 39%;
--chart-3: 197 37% 24%;
--chart-4:  43 74% 66%;
--chart-5:  27 87% 67%;
```

---

## Color Schemes (Accent Themes)

Applied via `data-color-scheme` attribute on `<html>`. Only `--primary`, `--primary-foreground`, `--ring`, `--variable`, and `--chart-1` change.

| Scheme | Token value (light) | Token value (dark) | Hex approx |
|--------|--------------------|--------------------|------------|
| `sunset` (default) | `24.6 95% 53.1%` | same | `#f97316` |
| `sky` | `188 94% 43%` | same | `#22d3ee` |
| `ocean` | `217 91% 60%` | `217 78% 51%` | `#3b82f6` |
| `forest` | `142 76% 36%` | `142 70% 45%` | `#22c55e` |
| `aurora` | `258 87% 74%` | same | `#a78bfa` |
| `coral` | `0 72% 65%` | `0 72% 55%` | `#ef4444`-family |

---

## HTTP Method Colors

These are **fixed semantic colors**, never substituted with theme tokens. Used in method badges, badges in RunItem, MethodSelector, DashboardHeader, etc.

| Method | Hex | Tailwind approx | Usage |
|--------|-----|-----------------|-------|
| GET | `#22c55e` | green-500 | Text + `bg-green-500/10 border-green-500/30` |
| POST | `#3b82f6` | blue-500 | Text + `bg-blue-500/10 border-blue-500/30` |
| PUT | `#f59e0b` | amber-500 | Text + `bg-amber-500/10 border-amber-500/30` |
| PATCH | `#a855f7` | purple-500 | Text + `bg-purple-500/10 border-purple-500/30` |
| DELETE | `#ef4444` | red-500 | Text + `bg-red-500/10 border-red-500/30` |
| HEAD | `#06b6d4` | cyan-500 | Text only (badge uncommon) |
| OPTIONS | `#6b7280` | gray-500 | Text only |

**Method badge pattern** (inline `<span>`, not a `<Badge>` component):
```tsx
<span
  className="text-[10px] h-5 px-1.5 font-mono font-bold shrink-0 inline-flex items-center rounded"
  style={{
    color: methodColor,
    background: `${methodColor}18`,   // ~10% opacity
    border: `1px solid ${methodColor}30`,  // ~19% opacity
  }}
>
  {method}
</span>
```

Or via CSS variable tokens (`--method-get`, `--method-post`, etc.) with utility classes `.method-get`, `.bg-method-get`.

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
body { font-family: "Space Grotesk", system-ui, sans-serif; }
/* mono via font-mono Tailwind class, or .font-code utility */
```

### Type Scale Conventions

| Use | Size | Weight | Class |
|-----|------|--------|-------|
| Section label / eyebrow | 11px | semibold, uppercase, +tracking | `text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground` |
| Hero metric value | 34px | bold | `text-[34px] font-bold font-mono` |
| Secondary metric value | 22px | semibold | `text-[22px] font-semibold font-mono` |
| Body / default | 13px | regular | `text-[13px]` |
| Small label | 12px | medium | `text-[12px] font-medium` |
| Micro / badge | 10–11px | mono bold | `text-[10px] font-mono font-bold` |
| URL / path | 12–13px | mono | `text-[12px] font-mono` |

---

## Geometry

```css
--radius: 0.375rem;   /* 6px — base border radius */
```

| Class | Value |
|-------|-------|
| `rounded` (default) | 4px |
| `rounded-md` | `calc(0.375rem - 2px)` = 4px |
| `rounded-lg` | `0.375rem` = 6px |
| `rounded-full` | pill / circle |

Cards and panels use `rounded-md`. Badges/chips use `rounded` or `rounded-sm`. Status pills use `rounded-full`.

---

## Animations

Defined in both `index.css` and `tailwind.config.js`.

| Name | Duration | Curve | Use |
|------|----------|-------|-----|
| `vayu-spin` | 0.7s | linear | Loading spinners |
| `vayu-pulse` | 1.6s | ease-in-out | Live indicators (0→35% opacity) |
| `vayu-fadepulse` | 2s | ease-in-out | Subtle breathe (90→50% opacity) |
| `accordion-down/up` | 0.2s | ease-out | Radix accordion |
| `fade-in` | 0.2s | ease-out | General reveal |
| `slide-in` | 0.2s | ease-out | Dropdown/panel entry |

**Spinner pattern:**
```tsx
<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-[vayu-spin_0.7s_linear_infinite] inline-block" />
```

**Live dot pattern:**
```tsx
<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
```

---

## Layout Structure

```
Shell
├── Sidebar (shrink-0)
│   ├── ActivityBar        44px wide   bg-panel border-r border-border
│   └── SidebarPanel       240px wide  bg-panel border-r border-border  (collapsible)
└── main (flex-1)          routes render here
```

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

- **Width:** `w-60` (240px), `bg-panel border-r border-border`, `overflow-hidden`
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
      ? <><Spinner /> Sending</>
      : <>▶ Send</>
    }
  </button>

  {/* Secondary action — token-based, never hardcoded purple */}
  <button className="h-[34px] px-3.5 rounded-md text-[12px] font-semibold text-primary border border-primary bg-primary/10 ...">
    <Zap className="w-3.5 h-3.5" /> Load Test
  </button>
</div>
```

### Dashboard Header (Compact 52px)

```tsx
<div className="h-[52px] flex items-center gap-3 px-5 bg-panel border-b border-border shrink-0">
  {/* Status pill */}
  {/* Method badge (inline span with style prop, not Tailwind) */}
  {/* URL — font-mono text-[12px] flex-1 truncate */}
  {/* Config summary — text-[12px] text-muted-foreground hidden sm:block */}
  {/* Stop button — ghost variant, destructive color */}
</div>
```

### SVG Sparkline (pure SVG, no Recharts)

```tsx
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
  const w = 108, h = 26;
  const pts = data.map((v, i) =>
    `${(1 + (i / (data.length - 1)) * w).toFixed(1)},${(1 + h * (1 - (v - min) / rng)).toFixed(1)}`
  );
  const area = `M1,${h + 1} L${pts.join(" L")} L${w + 1},${h + 1}Z`;
  return (
    <svg width={110} height={28}>
      <path d={area} fill={color} fillOpacity="0.15" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
```

### SVG Area Chart (replaces Recharts entirely)

Key settings: `viewBox="0 0 600 150"`, padding `PL=42 PR=8 PT=6 PB=20`, grid lines use `hsl(var(--border))` with `strokeDasharray="2 2"`, axis labels use `hsl(var(--muted-foreground))` in JetBrains Mono at `fontSize="9"`.

### Hero Metric Card

```
┌─────────────────────────────────────────┐
│ LABEL (11px, uppercase, muted)          │
│ 34px bold mono value    [sparkline 110w]│
│ sub-label (11px, muted)                 │
└─────────────────────────────────────────┘
```

```tsx
<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1">
  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
  <div className="flex items-end justify-between gap-2">
    <span className="text-[34px] font-bold font-mono leading-none text-foreground">{value}</span>
    {sparklineData && <Sparkline data={sparklineData} color={sparklineColor} />}
  </div>
  {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
</div>
```

### Latency Distribution Bar

Gradient track (green→amber→red, 18% opacity), with needle markers at p50/p95/p99. Each marker: absolute-positioned, `w-0.5 h-6 rounded-sm` pin + `w-4 h-4 rounded-full border-2 ring-4` dot + label below.

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
| Mono font | `font-mono` |
| Code font (utility) | `font-code` |
| Thin scrollbar | `scrollbar-thin` |
| Variable color | `text-variable` or `.variable-highlight` |

### Never use

- `bg-gray-*`, `bg-zinc-*`, `bg-slate-*` — use `bg-card`, `bg-panel`, `bg-background`
- `bg-blue-50`, `bg-red-950`, etc. — use `bg-destructive/10`, `bg-info/10`, etc.
- `dark:bg-*` hardcoded overrides — tokens handle both modes automatically
- Hardcoded `purple` for Load Test / secondary actions — use `text-primary/border-primary/bg-primary/10`
- `text-gray-500` — use `text-muted-foreground`
- `text-gray-400` in dark — use `text-muted-foreground`

---

## Response Body Syntax Highlighting

For JSON pretty-printer and code viewer (planned / pending implementation):

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
| `app/src/components/layout/Sidebar.tsx` | ActivityBar + SidebarPanel layout |
| `app/src/components/layout/Shell.tsx` | Root layout (Sidebar + main) |
