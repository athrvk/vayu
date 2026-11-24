---
description: >-
  The keyframe table, the motion vocabulary for entrances and exits, the reduced-motion rules and icon motion.
---

# Animations and motion

## Animations

Defined in `index.css`.
`tailwind.config.js` carries no keyframes or animation aliases, so a keyframe has one definition to keep in step.
The live indicator reaches `vayu-pulse` through an arbitrary class (`animate-[vayu-pulse_1.6s_ease-in-out_infinite]`).

| Name | Duration | Curve | Tailwind class | Use |
|------|----------|-------|----------------|-----|
| `vayu-pulse` | 1.6s | ease-in-out | `animate-[vayu-pulse_1.6s_ease-in-out_infinite]` | Live indicators (100→35% opacity) |
| `collapsible-down/up` | 0.2s | `--ease-enter` / `--ease-exit` | `animate-collapsible-down/up` | `CollapsibleContent`'s height (from `tw-animate-css`) |
| interaction state | 0.15s | ease | *(baseline in `index.css`)* | Hover/active colour changes on interactive elements |
| press feedback | 0.1s | ease-out | *(baseline, `[data-slot="button"]`)* | `scale: 0.98` on `:active` |

**Spinner pattern:** the lucide `Loader2` glyph, never a bordered `div` turned into a ring (`loading-idioms.test.ts` bans `border-t-transparent` outside `components/ui`).
See [Loading](component-patterns.md#loading).
```tsx
<Loader2 className="size-icon-sm animate-spin" />
```

**Live dot pattern** (as shipped in `ResponseStatusBar.tsx`):
```tsx
<span className="size-1.5 rounded-full bg-status-success animate-pulse" />
```

### Motion vocabulary (entrances and exits)

One curve pair and one duration per tier, declared once as CSS custom properties in `index.css` (just above the Dialog presentation rules) so every surface that arrives or leaves reads as the same hand.
Decelerate in (`--ease-enter`), accelerate out (`--ease-exit`) - a surface arriving should only ever slow down, and leaving is quicker than arriving because the decision is already made.

| Token | Value | Tier |
|-------|-------|------|
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | all |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | all |
| `--dur-panel-in` / `--dur-panel-out` | 180ms / 130ms | Dialog - the whole view dims |
| `--dur-menu-in` / `--dur-menu-out` | 140ms / 100ms | Popover, DropdownMenu, Select, ContextMenu |
| `--dur-tooltip-in` / `--dur-tooltip-out` | 100ms / 80ms | Tooltip - must read near-instant |
| `--dur-icon-nudge` / `--dur-icon-play` | 200ms / 280ms | Icon motion - a hover nudge that unwinds, a one-shot sequence (x2 for two-phase) |

**Dialog** (`.dialog-panel`/`.dialog-overlay`) consumes these directly in hand-written `@keyframes` - see the comment above them for why it does not use `tw-animate-css`'s stock utility stack (a centring hack it does not need, no overlay-sync problem the others don't have).

**Popover, DropdownMenu, Select, ContextMenu and Tooltip** keep `tw-animate-css`'s `animate-in`/`animate-out` stack (fade + `zoom-95` + a small directional slide from the Radix-exposed `transform-origin`) - there is no centring hack to cancel and no overlay to sync, so replacing it would be a hand-rolled copy of a primitive that already works.
What it does not give on its own is Dialog's decelerate-in/accelerate-out asymmetry - both directions run `ease` at the same duration by default.
It reads `--tw-duration`/`--tw-ease` ahead of its own defaults, so two small classes are enough: `.motion-menu` (menu tier) and `.motion-tooltip` (tooltip tier), each with a `[data-state="closed"]` variant swapping in the exit curve/duration.
Add whichever one to a new anchored-chrome primitive's content class list; never hand-roll its keyframes.

**Toast** cannot use either mechanism as-is: the store (`stores/toast-store.ts`) holds a dismissed toast for exactly `TIMING.TOAST_EXIT_MS` (200ms) before dropping the node, and that number has to equal the exit animation's duration or the node either lingers or gets cut off mid-flight.
So `toast-variants.ts` keeps its own pinned `duration-200` (which doubles as `--tw-duration`, feeding the same `animate-in`/`animate-out` mechanism above) and only borrows the curve: `[--tw-ease:var(--ease-enter)] data-[state=closed]:[--tw-ease:var(--ease-exit)]`.
Its swipe-cancel snap-back is a `transition-[translate,opacity]`, not `transition-all` - see the comment in that file for why `all` was there and what it actually needed.

**`.enter-fade`** is for a plain conditional mount with no Radix `data-state` to key off - `@starting-style` gives the "from" opacity for the element's first frame, so it fades in instead of popping on screen.
Entry only: React removes a conditionally-rendered node synchronously, so there is no exit half without JS-driven motion, which is out of scope (see Motion, below).
`EmptyState` is one call site among several - see `app/src/components/shared/EmptyState.tsx`, `app/src/components/ui/suggestion-list.tsx` and `code-editor.tsx`'s `LeaveEditorHint` for the plain-mount shape, and `LabelSwap` (`label-swap.tsx`) below for the label-swap shape built on the same class.
Its duration defaults to the menu tier via `--enter-fade-duration, var(--dur-menu-in)` - right for the small surfaces above, but a mount that is panel-scale rather than a strip of chrome overrides it at the call site, `--tw-*`-style:
`Drawer.tsx`'s sidebar-page swap (`key={drawerView}` plus `enter-fade [--enter-fade-duration:var(--dur-panel-in)]` on the wrapper, so switching Collections/History/Variables/etc. fades rather than pops) is the one call site so far.

**`TabsContent`** (`tabs.tsx`) is the one place `.enter-fade` sits on an element that *does* carry a Radix `data-state` - `data-[state=inactive]:hidden` toggles the native `hidden` attribute rather than mounting/unmounting, so there is no conditional-render moment for `.enter-fade` to key off in the usual sense.
`@starting-style` fires on any change of display type, `none` to something else included, which is exactly what a `hidden` toggle is - so the same class still applies, and re-fires on every switch back to an already-visited tab, not just the first.
A force-mounted panel (`forceMount`, e.g. Collection Detail's four draft-preserving tabs) gets the same fade for the same reason: it never truly unmounts, only its `hidden` attribute flips.

**`LabelSwap`** (`app/src/components/ui/label-swap.tsx`) is for a button/badge/status label that changes text in place - "Send" → "Sending" → "Send".
It solves two problems together, both of which a naive `key={label}` + `.enter-fade` on the bare text gets wrong: the text fading is not the only thing that changes (the *box* resizes too, since "Sending" is wider than "Send", and Apple's version never moves the control around it), and the fade needs the DOM node to actually remount for `@starting-style` to fire again.
The fix for the first is `TabLabel`'s (`tabs.tsx`) width-reservation trick generalised to more than one word: every candidate string in `states` sits in the same CSS grid cell, `invisible` and `h-0`, so the column is sized by the widest one while only the visible text contributes height; `aria-hidden="true"` on those twins keeps a screen reader from hearing every candidate read out.
The fix for the second is `key={label}` on the live span, which remounts it - and therefore replays `.enter-fade` - every time `label` changes.
`states` must be the finite, enumerable set the caller already knows; it is not inferred by watching `label` over renders (that would start too narrow and still jump the first time a wider state appears), and a data-derived label (a count, a status string from a payload) has no fixed "widest" to reserve, so `LabelSwap` is the wrong fit for one.

**`TabCount` / `TabErrorDot`** (`app/src/components/ui/tabs.tsx`) are the answer for the data-derived case `LabelSwap` turns away.
A mark beside a tab label is a flex item on a `shrink-0` trigger inside a `flex-nowrap` list, so one that *mounts at full width* widens its trigger by its own width plus the trigger's `gap-1.5` and pushes every trigger to its right - and whatever else shares the row - along with it;
typing the first character into an empty Params table moved the seven tabs after Params and the `Table` toggle past them.
A hidden widest twin cannot fix it either, because a count is a number rather than one string rendered two ways.

The fix is `MARK_TRACK`: a `grid-template-columns: 0fr -> 1fr` transition (the standard technique for animating an element's own contribution to a flex/grid container's size without a fixed target width - `0fr` is exactly zero, `1fr` resolves to the content's intrinsic size, and both are real track values a `transition` can interpolate between, unlike animating to `auto`).
`-ms-1.5`/`ms-0` cancels and restores the trigger's `gap-1.5` in step with the track, so an empty mark costs nothing at all, not even the gap before it - an earlier version held a permanent `min-w-[1ch]` slot open instead, which stopped the jump but paid that width on every countable tab whether or not anything was ever counted, which is exactly the standing cost this replaces.
`TabCount` stays mounted with empty content when there is nothing to count (per its own contract below), so a value changing is a track-width transition on an already-present node, not a fresh mount -
`TabErrorDot`'s one call site swaps it in for a `TabCount` outright, so that *is* a fresh mount, and needs `starting:grid-cols-[0fr]` (`@starting-style`) for a "before" frame to animate from, the same way `.enter-fade` does for a plain conditional mount.

**`presence`** is the variant for a tab that has *something here* but nothing to count - Info, Body, Auth and Settings on the request tabs (#2199).
Those passed `1`, which read as a count of one next to Params and Headers, whose numbers are real.
`<TabCount value={x ? 1 : undefined} presence />` draws a 5px accent dot (`bg-primary-text`) in place of the digit: any non-empty `value` means present, and the same `MARK_TRACK` and `useHeldValue` exit apply, so the dot grows in and fades out exactly as a number does.
The dot is `aria-hidden` and the cell holds no text, so the trigger's accessible name stays the bare label ("Body", not "Body 1").
A tab that has a real quantity (Params, Headers, Elements, the response viewer's tabs) stays a numeric `TabCount`.

Two consequences for call sites: render `TabCount` **unconditionally** wherever a tab can carry a count, passing `undefined` for none (gating the element is what reintroduces the jump), and render none at all on a tab that never can, so it pays no width, ever - not even a collapsed track.
A count crossing 9 to 10 still grows the trigger by a digit and moves its neighbours, because `1fr` sizes to the content's actual width; that is content genuinely growing, not a defect the mechanism is meant to hide.

**Holding the last content through an exit** is the one place this system spends JS on motion, and it is the other half of the `.enter-fade` limitation above.
A mark whose content is conditional (`{count ? … : null}`, `{hasResults && <Badge/>}`) is removed from the tree in the same commit its state goes back to empty - so a container animating around it at that moment, `MARK_TRACK`'s `1fr -> 0fr` most often, spends its whole duration collapsing around an already-empty box while the thing that carried the meaning was cut in one frame.
The container's own motion is what makes it easy to miss: something *is* moving, just not that.
`useHeldValue` (`app/src/hooks/useHeldValue.ts`) separates what is true from what is drawn - the live value drives the container so the collapse starts on time, and `shown` holds the outgoing content for a beat so an opacity transition keyed off `fading` has a populated node to take out.
The reference implementation is `useSaveStatusDisplay` in `app/src/components/layout/Dock.tsx`, which is the same shape specialised to the save store (it also floors how long "Saving…" stays up); `TabCount` and the response viewer's `TestsResultChip` use the general form.
Two durations, because the two play the halves in a different order: the Dock's line is centred in its track, so it fades first and collapses after (`TIMING.SAVE_LINE_FADE_MS`, 200ms, matching its own `duration-200`);
a mark is a digit or a four-character chip already clipped by `overflow-hidden`, so it fades *while* its track closes, one gesture at `TIMING.MARK_FADE_MS` (150ms, matching `MARK_TRACK`'s `duration-150`).
It applies only where content genuinely goes to *nothing* - `LabelSwap` and `IconSwap` move between known non-empty states and need none of it.

**`IconSwap`** (`app/src/components/ui/icon-swap.tsx`) is the same mechanism for a glyph instead of a word - Copy → Check, Eye → EyeOff, Play → Square, Folder → FolderOpen.
Every icon in the `icons` map renders into one grid cell, the reserve twins `invisible h-0` and `aria-hidden` (every one of them, the live state's included, so the box is the same size whichever state is showing), and `key={state}` on the live cell remounts it so `.enter-fade` replays.
Two glyphs of the same nominal size are still not the same width of ink, and a pair where one carries a `mr-1.5` is enough to shift the label beside it, which is what the reservation prevents.
It is a *different mechanism* from `data-icon-motion` (Icon motion, below), not a variant of it: a motion animates one glyph that stays itself and is triggered by its owner's hover, a swap crossfades between two glyphs and is triggered by state.
`IconSwap` puts nothing of its own on the nodes it is handed, so an icon can do both.
Entry only, for `.enter-fade`'s documented reason, and a state that flips back inside one fade duration reads as a flicker rather than a crossfade - the accepted cost of staying JS-free.

**`CollapsibleContent`** (`app/src/components/ui/collapsible.tsx`) is the one disclosure that animates its own height, and it does it with `tw-animate-css`'s stock `collapsible-down`/`collapsible-up` keyed off Radix's `data-state`.
Radix measures the open box into `--radix-collapsible-content-height` and those keyframes already read it, so there is nothing to hand-roll: the class list is `overflow-hidden` (what makes the height clip rather than squash) plus `data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up`.
The curve is borrowed the Toast way, file-local, because the generated `--animate-collapsible-*` value reads `--tw-ease` ahead of its own `ease-out`: `[--tw-ease:var(--ease-enter)]` with a `data-[state=closed]` twin swapping in `--ease-exit`.
The duration stays tw-animate-css's 200ms - the three tier tokens are all about chrome arriving over the view, and inline content pushing its siblings down is not that.

Two things a caller has to know.
**`overflow-hidden` is permanent while the section is open, not just while it animates**, so this box does clip an outset focus ring - and it deliberately does *not* answer that with `.panel-clip`.
The same `Input`, `Switch` or row-enable checkbox renders both inside a disclosure and outside one, so tucking the ring inward here would give one control two looks depending on where it sits: the clearance-over-tucking rule below, which `key-value-parity.test.tsx` already guards for the checkbox.
A consumer whose control sits flush against the box's left, right or bottom edge adds clearance of its own - `px-3 py-3`, the way the load-test dialog's disclosures do it.
**"A collapsed section costs nothing" rests on `CollapsibleContent` itself, not on a caller-side guard.**
Radix's `CollapsibleContentImpl` renders `isOpen && children`, so closed content is unmounted - hooks stop, queries stop - without `context-bar/Section.tsx` or `ScriptSnippets.tsx` re-deriving that with their own `{expanded && children}`.
A manual guard would unmount the instant the trigger toggles and skip the 200ms close keyframe entirely, since Radix would be animating an already-empty box.
The one behavioural consequence of leaving it to Radix: a collapsed section's children stay mounted, hooks and all, for the ~200ms close animation before Radix drops them.

**Press feedback** (`scale: 0.98` on `[data-slot="button"]:active`) uses the standalone `scale` property, not `transform: scale()`, so it composes with any `transform` the element already carries rather than clobbering it - same reasoning as the `translate` note in the Dialog comment.
`scale` is listed in the *same* baseline `transition:` shorthand as the colour properties (`background-color, color, border-color, opacity, scale`), not a second rule on `[data-slot="button"]`:
a `transition:` shorthand resets every sub-property, so a second rule at the same `:where()` specificity would have replaced the colour list instead of adding to it, and every Button's hover fade would have silently stopped transitioning.
`scale` is inert on everything except `[data-slot="button"]:active`, the only place anything sets it.
`button-variants.ts` deliberately does not carry Tailwind's `transition-colors` utility - that class lives in `@layer utilities`, which beats the `@layer base` baseline, so it would win the cascade and replace that whole list.

---

## Motion

Motion collapses for two independent reasons, and both must keep working.

```css
/* index.css - outside @layer, so the !important declarations win */

/* 1. The in-app toggle: Settings → Appearance → Reduced motion */
html[data-reduced-motion="true"], html[data-reduced-motion="true"] * { … }

/* 2. The system preference, which a user states once for every app */
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }
```

Both collapse the same four properties - `animation-duration`, `animation-iteration-count`, `transition-duration`, `scroll-behavior`.
A declaration added to one and forgotten in the other leaves the system-preference path animating something the toggle stops, which `reduced-motion.test.ts` guards.

**The system preference was ignored until it wasn't.**
The toggle shipped first, and `prefers-reduced-motion` appeared nowhere in the stylesheet - so someone who had turned Reduce Motion on in Windows, macOS or GNOME got every animation until they found a checkbox in Vayu and said it a second time.

**The two are additive, and deliberately only in one direction.**
The toggle forces the collapse for a system that asks for nothing.
There is no way to opt *back into* animation against a system that asked for less; that is the one direction where guessing wrong has a cost.

**Which means the switch can read "off" while nothing animates**, so the Appearance panel says so when `usePrefersReducedMotion()` is true.
Without that line the only explanation for the app's behaviour lives in another application's settings.

**Nothing animates from JavaScript.**
No `element.animate()` and no property tweened frame by frame:
`requestAnimationFrame` is for measuring, resizing and stepping a scroll (`lib/resize-gesture.ts`, the tree's drag auto-scroll in `useTreeDnd.ts`), and the two `scrollIntoView` calls (`components/ui/command.tsx`, `SendWithRowDialog.tsx`) pass `block: "nearest"` and no `behavior`, so they follow the `scroll-behavior` the rules above set.
Keep it that way: JS-driven motion is invisible to both rules and would need its own opt-out.

### Icon motion

An icon animates only as feedback for the action it is the affordance for, and the rules that do it are CSS, in the `Icon motion` block of `app/src/index.css`.
There is no `motion`/framer-motion dependency and there will not be one: the lucide-animated registry ships a component per icon, each wrapping the glyph in a `div` that breaks `button-variants.ts`'s `[&_svg:not([class*='size-'])]:size-icon` sizing and its `[&_svg]:pointer-events-none`, and JS-driven motion is invisible to both collapse rules above.
A transition or a keyframe animation is stopped by them for free.

The policy, in five rules:

1. **The owner triggers, never the icon.**
   A motion fires from the `:hover` / `:focus-visible` of the glyph's own `[data-slot="button"]` or the `.group` row that reveals it - never the SVG's own hover, which `[&_svg]:pointer-events-none` has already taken away.
   `:focus-visible` is not optional: a keyboard user gets the same feedback a mouse user does.
2. **A glyph conveying a state never animates** - and that is a rule about *placement*, not about which glyph it is.
   The six glyphs that usually carry a state (`AlertTriangle`, `AlertCircle`, `CheckCircle2`, `XCircle`, `Clock`, `Info`) animate nowhere they are the message: a status chip, a row's status column, an inline warning, a panel heading.
   A state the user is being told about is not an action they can take, and a success tick that grows under the pointer invites a click on something that does nothing.

   Where one of those same glyphs *is* the affordance for an action - inside a `[data-slot="button"]`, a menu item, a tab trigger, a `RowAction`, or a registry entry a rail draws as a button (`DRAWER_VIEWS`) - it animates like any other action glyph.
   History's `Clock` in the Activity Rail is the case this was refined for (#1707): it means "go to History", and it earned a motion of its own rather than nothing.
   `icon-motion-status.test.ts` encodes the distinction the same way, by the owner the element sits inside.
3. **A state change animates once.
   Loops are reserved** for `Loader2` and live indicators, where the loop is the message ("work is happening").
4. **Every transform of an SVG child declares `transform-box: fill-box` and an explicit `transform-origin`.**
   The initial reference box is the `view-box`, so a percentage origin otherwise resolves against the whole 24x24 canvas instead of the path, and a hinge lands nowhere near the hinge.
   Use the standalone `rotate` / `translate` / `scale` properties, never `transform:`, so they compose with any `transform` the element already carries - the same reasoning as press feedback's `scale`.
5. **Durations and eases come only from the `--dur-*` / `--ease-*` tokens**, through `--icon-motion-duration`.
   That name is deliberately not `--tw-duration`: a `.motion-menu` / `.motion-tooltip` ancestor sets that one for `tw-animate-css`, and reading it here would let a menu's tier leak into the glyph inside it.
   No `will-change` - a standing compositor hint on every icon in a hovered row costs more than a 12px glyph's 200-560ms buys.

A call site spells the name once, as `data-icon-motion` on the icon, and takes it from `ICON_MOTION` in `app/src/components/ui/icon-motion.ts` so a name the stylesheet does not implement is a compile error rather than a dead attribute.

| Name | Icons | Motion | Duration | Leaves the frame |
|------|-------|--------|----------|------------------|
| `lid` | `Trash2` | Lid bar and handle hinge up off the can (`rotate: -12deg`, `translate: 0 -1px`) about the bar's left end | `--dur-icon-nudge` | yes |
| `hands` | `Clock` | The hands polyline sweeps one full revolution about the dial centre (12,12); the dial stays | `--dur-icon-play` x2 | no |
| `waves` | `Radio` | The four arcs travel outward and fade, inner pair then outer pair; the centre dot stays | `--dur-icon-play` x2 | yes |
| `spread` | `Braces` | The two curves part by 1px each, outward, and close again | `--dur-icon-nudge` | no |
| `tilt` | `FolderOpen` | Tips `-6deg` with a 4% grow about the ink's bottom-left corner (2,20) - a folder opening toward you | `--dur-icon-nudge` | yes |
| `wiggle` | `Search` | `-8deg`, `+8deg`, back, once, about the lens centre (11,11) | `--dur-icon-play` | no |
| `drop` | `Download` | The arrow (shaft and head) drops 2px into its tray; the tray stays | `--dur-icon-nudge` | no |
| `lift` | `Upload` | The arrow rises 2px out of its tray; the tray stays | `--dur-icon-nudge` | yes |
| `press` | `Save` | The whole glyph goes to 92% and back, a button pressed | `--dur-icon-play` | no |
| `tilt-pin` | `Pin`, `PinOff` | Leans `-20deg` about the needle's point (12,22) and rights itself | `--dur-icon-play` | yes |
| `ring` | `Bell` | A decaying swing (`+12deg`, `-10deg`, `+6deg`, 0) about the point it hangs from (12,2) | `--dur-icon-play` x2 | yes |
| `bob` | `Info` | A 1.5px rise and settle, for a mark with no part to hinge and no direction of its own | `--dur-icon-play` | yes |
| `part` | `Code2`, `Code` | The two chevrons part by 1px each. `spread`'s reading against a glyph lucide draws right-to-left, which is why it is not that name | `--dur-icon-nudge` | yes |
| `tiles` | `LayoutDashboard` | The four tiles step 1px away from the frame's centre and back, diagonal pairs staggered | `--dur-icon-play` | no |
| `sweep` | `Gauge` | The needle swings `-70deg` about its hub (12,14) and returns; the dial stays | `--dur-icon-play` x2 | no |
| `plug-in` | `Plug` | 1.5px along the axis the prongs point, which is up | `--dur-icon-nudge` | yes |
| `pulse` | `Network` | The three node rects swell 18% in turn, top node first; the connectors stay | `--dur-icon-play` x2 | no |
| `trace` | `Activity` | The trace is stroked on from its left end, over a measured path length | `--dur-icon-play` x2 | no |
| `stack` | `Database` | The top disc lifts 1.5px off the stack and settles back | `--dur-icon-nudge` | yes |
| `spin-once` | `RefreshCw` | One 360deg turn (`@keyframes icon-spin-once`), so pointer-out does not unwind it backwards | `--dur-icon-play` | no |
| `spin-back` | `RotateCcw` | The same turn counter-clockwise, for "put it back" rather than "do it again" | `--dur-icon-play` | no |
| `flash` | `Zap` | Dims to 40% and back with a 6% grow - a strike, not a movement | `--dur-icon-play` | no |
| `rotate-90` | `Plus`, `X` | A quarter turn; both glyphs are symmetric under it, so only the movement is visible | `--dur-icon-nudge` | no |
| `nudge-x` | `ChevronRight`, `SlidersHorizontal` | 1px along the direction it points | `--dur-icon-nudge` | no |
| `nudge-y` | `ChevronDown` | The same, vertically | `--dur-icon-nudge` | no |
| `scale` | `Play` | The whole glyph grows 10% - the last resort for a mark that is one path with no reading of its own to act out | `--dur-icon-nudge` | no |

A motion whose ink leaves the 24-unit viewBox sets `overflow: visible` on the `svg`, because an inline SVG clips to its viewBox by default and the travel is simply cut off at every call site.
The column above is the list, and `icon-motion.test.tsx` holds it to the stylesheet - in both directions, so a `visible` on a motion that stays inside is caught too.

**A draw-in is measured, never guessed.**
`trace` strokes its path on with `stroke-dasharray` and `stroke-dashoffset`, and the dash has to be at least the path's own length or a second dash creeps in behind the first.
Measure it with `getTotalLength()` in a real browser, round up, and write the measurement and where it came from in the rule's comment.
Both properties are set *inside* the keyframes, never on the element: a dasharray parked on the glyph is a permanent property that happens to look solid today.

**Two glyphs that read alike may still need two names.**
`spread` (`Braces`) and `part` (`Code2`, `Code`) are the same idea - a pair of marks parting by a pixel - and cannot share a rule, because lucide draws `Braces` left-bracket first and both code glyphs right-chevron first.
Reusing one name would have drawn the brackets *closing*, which looks like a considered choice in a diff.
When the reading matches but the child order does not, the second name is the honest answer.

A sequence that genuinely needs longer than its tier - `hands`, `waves`, `ring`, `sweep`, `pulse`, `trace` - multiplies the token (`calc(var(--dur-icon-play) * 2)`) rather than introducing a literal, and says why in the rule's comment.
A stagger inside a sequence is keyframe percentages, never `animation-delay`: the reduced-motion rules collapse a duration, not a delay, so a delayed step would survive them as a pause before an instant jump.

Lucide renders its `__iconNode` children in declared order with nothing prepended, which is what lets a rule address `> path:nth-child(4)`.
That is a dependency on an upstream glyph's shape, so `icon-motion.test.ts` pins the index against the exported `__iconNode`: a redrawn `Trash2` fails a test instead of animating the wrong path.
The same guard holds the four rules above to the stylesheet - trigger selectors, `fill-box`, token-only timing.
