---
description: >-
  The four dialog widths, the one height cap and the band that scrolls.
---

# Dialog widths and height

## Dialog widths: four sizes

| Size | Class | For |
| ---- | ----- | --- |
| Standard | `sm:max-w-lg` (512px) | A form or a decision - a confirm, a rename, a picker, a short field set. |
| Wide | `max-w-xl` (576px), the primitive's default | A dialog holding something with a shape of its own: a table, a diff, a preview, a dense config. |
| Browser | `sm:max-w-2xl` (672px) | A dialog whose job is *reading* that shape and picking out of it, not confirming something about it. One call site: the data-row picker beside Send. |
| Two-pane | `max-w-xl lg:max-w-4xl` (576px, 896px from the `lg` breakpoint) | A dense config that is two independent groups, which a single column makes scroll past one to reach the other. One call site: the load-test dialog, with the run's shape on the left and what it records and checks on the right. Below `lg` it is the Wide column. |

These had drifted to five values across eleven call sites, including two one-off pixel widths, so the same kind of dialog came out a different size depending on who wrote it.
`dialog-width-scale.test.tsx` holds the set closed; a dialog that genuinely needs another size widens the scale here and in `dialog.tsx`, with the reason, rather than opening a one-off.

`2xl` was opened for the row picker (issue #892): seven columns of ordinary CSV at 576px leaves about 60px a column, which is one truncated cell per column and nothing scannable.

`lg:max-w-4xl` was opened for the load-test dialog (issue #2231), whose fields had grown to a single column taller than a laptop viewport.
The width is not what earns it: the content is two groups that do not depend on each other, laid side by side from `lg` (1024px).
The size is the two-pane one only - a dialog that is one group wanting more room still wants a pane elsewhere, not a wider modal.
A two-pane dialog pins anything that explains a disabled Start (its notices) between the header and `DialogBody`, so it cannot scroll away inside one column.

Prefer a **cap** (`max-w-*`) over a fixed `w-[…]`: a fixed width is one the panel keeps on a viewport narrower than it, where `w-full` under a cap gives the same stable band and still fits.
And widening is never the fix for content escaping the panel - a wider panel with an `auto` track spills exactly the same way, just further along.
Clamp the track; widen only for the reading.

## Dialog height: one cap, and the band that scrolls

A dialog panel is `fixed` and centred by a translate, so a panel taller than the viewport is centred on a box it does not fit: clipped at the **top and the bottom** at once, with nothing to scroll, because a fixed box does not scroll the page.
The footer is the half that goes, which makes the dialog's primary action unreachable by pointer - and only *by pointer*, since Tab still reaches it, which is how this survived fourteen call sites (issue #773).
Measured in Chromium at a 613px viewport, an eighteen-row dialog put its Run button 227px below the screen.

The panel therefore declares `max-h-[85vh]`, and the band between the header and the footer is a **`DialogBody`**:

```tsx
<DialogContent className="sm:max-w-xl">
  <DialogHeader>…</DialogHeader>
  <DialogBody className="space-y-4 py-2">…</DialogBody>   {/* the only scroller */}
  <DialogFooter>
    <DialogCancelButton onClick={() => onOpenChange(false)} />
    <Button onClick={handleConfirm}>Run</Button>
  </DialogFooter>
</DialogContent>
```

**The declining action is `DialogCancelButton`, never a `Button` you pick a variant for** (issue #1693).
The same word carried three variants across the app - `outline` in five dialogs, `secondary` in three, `ghost` in three, plus one hand-rolled `<button>` with a copied class list - so which one a user saw depended on which dialog they opened.
The primitive settles it on `secondary`, matching `DeleteConfirmDialog`, the dialog this app shows most often, and it deliberately does not take a `variant` prop: a call site that can choose is a call site that can drift.
`label` renames the word ("Not now", "Keep it"), `size` and `className` pass through for the inline forms outside a `DialogFooter` that draw the same button in a denser row.
`components/ui/dialog-cancel.test.ts` bans a `Cancel` label anywhere else.
It is also the URL bar's Cancel for a buffered send in flight (#3352), because it is the one control that draws the word; `StopRunButton` is for runs and streams, which have a run id the engine can stop, whereas a buffered send has nothing to stop engine-side and Cancel only ends the renderer's wait.

Three rules hold it together:

- **The body scrolls, never the panel.**
  `overflow-y-auto` on the panel is the tempting one-liner and it is the wrong one: the corner close button is `absolute` *inside* the panel, so it scrolls away exactly when the dialog is long enough to need a visible way out.
  The panel keeps one anyway as a fallback for a dialog with no band; with a band present the panel never scrolls and the button stays pinned.
- **`min-h-0` on the band is load-bearing**, for the same reason `min-w-0` is one section up: a flex item's automatic minimum on the main axis is its content, so without it the band refuses to shrink and the overflow moves straight back out to the panel.
- **`flex-auto`, not `flex-1`.**
  Basis `0%` asks a short dialog to stretch its one band over the whole cap; basis `auto` grows only into height that is free.

Header and footer are `shrink-0` so they stay bands rather than being the first thing squashed.
A dialog with no middle to scroll - a confirm, a rename - needs no body.
A dialog that manages bands of its own (`ImportModal`) or whose content is already a self-scrolling list (`CommandDialog`) opts out at the call site with the reason written there; `dialog-height-band.test.tsx` holds that list closed, so a new dialog cannot skip the band silently.

Opting out of the band does not opt out of the shape.
The command palette's keyboard hints are a `CommandFooter` - `shrink-0`, a sibling of `CommandList` and never a row inside it - because the rule is about what scrolls, not about which primitive names it: hints that scroll away with the results they describe are hints nobody reads.
Nor does opting out excuse the cap: the list that scrolls in place of a band owns one of its own, and the palette's is `min(400px, 60vh)` (#1177) rather than a bare pixel value, so the input, the list and the hints together stay inside the panel's `85vh` on a short window instead of being clipped by the `overflow-hidden` that keeps the list's scroll the only one.
