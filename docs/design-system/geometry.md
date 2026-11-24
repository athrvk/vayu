---
description: >-
  The geometry tokens: the base radius, the dock height and the rail width, and why a fixed element reads them.
---

# Geometry

```css
--radius: 0.375rem;      /* 6px - base border radius (default) */
--dock-height: var(--spacing-band); /* 32px - footer status strip */
--rail-width: 2.5rem;    /* 40px - ActivityRail and ContextRail */
```

**`--dock-height` exists because a `fixed` element has to know it.**
The Dock is the last row of the shell column, so the layout keeps everything else clear of it automatically.
The toast viewport is `position: fixed` and anchors to the window instead, so it has to subtract the strip's height by hand - and with a plain `bottom-4` it did not, landing 16px off the window floor, inside the Dock's 32px band and covering its lower half, "Engine connected" and the version string included.
Measured in the app: viewport bottom 704px against a Dock top of 688px.

Both sides now go through the token - `h-[var(--dock-height)]` on the Dock, `bottom-[calc(var(--dock-height)+1rem)]` on the viewport - so the height cannot change in one place only. jsdom does no layout and cannot measure the overlap, so `toast-position.test.tsx` guards the *reference* on each side instead.

**`--rail-width` is the same rule at the window's side edges** (#1615).
Both `ActivityRail` (left) and `ContextRail` (right) read it, so the app can never end up with two window-edge navigation strips of different widths - a single `w-[var(--rail-width)]` on each is what keeps them in step, the same way one `--dock-height` keeps the Dock and the toast viewport from drifting apart.
Unlike the Drawer and the ContextBar, a rail is not user-resizable: it holds a fixed row of icon buttons, so a token rather than a `PANEL_MIN_WIDTH`-style stored preference is the right amount of mechanism.

| Class | Value | Follows the setting? |
|-------|-------|----------------------|
| `rounded-sm` | `calc(var(--radius) - 4px)` | yes |
| `rounded-md` | `calc(var(--radius) - 2px)` | yes |
| `rounded-lg` | `var(--radius)` | yes |
| `rounded-full` | circle, or a track that is a capsule | no - deliberately fixed, and only for a shape that *is* a circle (see below) |
| `rounded-none` | `0` | no - deliberately fixed |
| `rounded` | Tailwind default | **no - never use it** |

**Never use bare `rounded`.**
It resolves from Tailwind's own default rather than `--radius`, so it sits at 4px whatever the user picks - measured 4px at `0rem`, `0.375rem` and `0.75rem` alike, while `rounded-md` moved 0 → 4 → 10.
Three had drifted into the MCP settings panel, staying rounded for anyone who had chosen Square.
A test (`radius-token.test.tsx`) now fails on any bare `rounded` in a class string.

**Inline `borderRadius` escapes the setting too**, and no class scan sees it.
The uPlot chart tooltip carried `borderRadius: "6px"`, so it stayed rounded on Square and stopped short of the app's own tooltip on Rounded; it is now `var(--radius-md)`, measured 0 / 4 / 10 across the three settings.
Inline radii are allowed only as a `var(--radius…)` reference or a percentage (a circle) - plus the Appearance panel's own roundedness swatches, which must show every option regardless of which one is active.
The same test enforces this, across `.ts` as well as `.tsx`.

**User-adjustable.**
Settings → Appearance → Interface → Roundedness sets `--radius` (Square `0rem` / Default `0.375rem` / Rounded `0.75rem`), owned by `appearance-store`, persisted, applied pre-paint.
So `rounded-sm/md/lg` reshape live.
**Always use `rounded-md`/`rounded-lg`/`rounded-sm`, never Tailwind's unsuffixed `rounded`** (fixed 4px - it ignores `--radius` and won't follow the control).
`rounded-full` does not follow it either, which is why it is reserved for shapes that are circles (below), never for a button or a chip.

The primitives are the reference, not a table of their own: `Badge` and the chips that match it are `rounded-md` (`badge-variants.ts`), `Card` is `rounded-lg` with `shadow` (`card.tsx`), and a bordered panel that is not a `Card` takes `rounded-md`.
A card you need is `Card` / `CardHeader` / `CardContent`; a hand-rolled `bg-card border rounded-md` copy does not receive the primitive's fixes and is drift that the drift sweep removes, not a second recipe.

**Elevation steps in use**, so a new surface picks one rather than inventing a shadow:
`shadow-sm` on form controls (`Input`, `Select` trigger, `Switch` track, the non-default `Button` variants), plain `shadow` on `Card` and the solid primary `Button`, `shadow-md` on popovers and menus (`Popover`, `DropdownMenu`, `ContextMenu`, `Select` content, the suggestion lists), `shadow-lg` on `Dialog` and the toast.
The stray is the dropdown submenu (`dropdown-menu.tsx` `DropdownMenuSubContent`), which sits at `shadow-lg` while its parent menu is `shadow-md`; the `Switch` thumb's `shadow-lg` is a knob on a track, not a surface.

**`rounded-full` is for circles, not for chips.**
Status dots, spinners, circular icon wells, colour swatches, switch tracks - things whose shape *is* a circle or a capsule.
It is not for anything rectangular that merely looked nicer with round ends: the dashboard header's LIVE / COMPLETED / STOPPED chips were `rounded-full` while the `Badge` primitive they otherwise match is `rounded-md`, so on Square they were the only round things left on the screen.
They are `rounded-md` now, and so are the element list's quick-add buttons and the inherited-elements notice's kind chip (a `Badge variant="chip"`, #3501).

The radius guard allows the class, because no source scan can tell a chip from a dot (`radius-token.test.tsx` is silent on it), so this one is a judgement call at review time.
The question to ask: if the user picks Square, should this element go square?
If yes it is a chip, and `rounded-full` is wrong.
A track whose shape is the capsule (the progress bar, the switch) is the exemption, and says so under its own heading.

The same reasoning rules out `rounded-full` on controls - a button or dropdown trigger that keeps its pill shape becomes the one thing on screen ignoring the Roundedness setting.
Interactive elements take `rounded-md`/`rounded-sm`.
Render the two sites that carried it (`ElementList`'s quick-add buttons, `InheritedElementsNotice`'s kind chip) and read `className`, as their tests do.

**A control that renders at more than one box size caps the token by proportion instead of using it bare.**
`Checkbox` (`ui/checkbox.tsx`) is instantiated at 12-28px depending on caller (`size-icon-sm`, `size-icon`, `size-target`), and `--radius-md` is a fixed length - 10px at Rounded, past half the width of a 12-16px box.
Applied bare, a checkbox at Rounded became a circle indistinguishable from a radio button, while the same class on the 24-28px row-enable checkbox stayed an ordinary rounded square: one token, two unrelated shapes.
The fix is `rounded-[min(var(--radius-md),25%)]`: Square (`--radius: 0`) is unaffected at every size, Rounded caps at a quarter of the box instead of degenerating into a circle, and the cap only ever removes roundness from a small instance - it never adds any to a large one.
The next control that varies its own box size (a radio, a colour swatch) should reach for the same `min(token, %)` shape rather than relearning this.
