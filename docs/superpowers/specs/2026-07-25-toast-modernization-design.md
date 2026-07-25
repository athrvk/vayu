# Toast modernization - design

Date: 2026-07-25
Branch base: `master` @ 38a16b4

## Goal

Make Vayu's transient notifications modern, theme-aware and useful, and make them
the **single** channel for reporting the outcome of an action the user took.

## Where we are

Two files, 123 lines. [`app/src/stores/toast-store.ts`](../../../app/src/stores/toast-store.ts)
is a Zustand queue with a fixed 4s timer;
[`app/src/components/shared/Toaster.tsx`](../../../app/src/components/shared/Toaster.tsx)
renders a bottom-right stack, mounted once in `App.tsx:72`. Three variants
(`info`, `success`, `error`), 22 call sites across 8 modules.

The accessibility layer is well-built and carries earned rationale: a persistent
viewport that pre-exists its content, `role="status"` + `aria-live="polite"` +
an explicit `aria-atomic="false"`, and no per-toast live regions. Six tests in
`Toaster.test.tsx` guard it.

### Defects

1. **Dark-mode variant collapse.** Error uses `border-destructive/40`, success
   uses `border-status-success/40` - two token families for one job. In dark
   `--destructive` is `0 62.8% 30.6%`; at 40% alpha over `--popover`
   (`240 6% 11%`) it is close to invisible, so an error toast and an info toast
   look alike. The variant signal is border-only: no icon, no fill, no coloured
   text. Colour alone, at 40% alpha, is the whole signal.
2. **No motion.** Toasts appear and vanish with no transition, while every other
   overlay in `components/ui/` uses `animate-in` / `data-[state]` transitions.
3. **No queue discipline.** No stack cap (repeated failures run off-screen), no
   dedup, no hover-to-pause.
4. **Weak dismiss affordance.** A 14px icon with no hit padding, no radius class
   and no `focus-visible` ring.
5. **Two competing failure channels.** `showToast` in dialogs / dashboard / MCP /
   OAuth; `failSave` -> the Dock in `CollectionTree`, `useSaveManager`,
   `SettingsMain`, `VariableTableEditor`. The same event class reports to two
   surfaces depending on the file. A failed *delete* currently makes the Dock
   say "Save failed - ...", which is the wrong sentence.
6. ~~**Genuinely silent paths.**~~ **Withdrawn - this was wrong.** The initial
   analysis called `DesignRunView.tsx:258` and `dashboard/index.tsx:99` / `:128`
   silent because each opens with a bare `console.error`. Reading past that line
   shows all three already report: `:128` sets `reportError`, rendered in a
   Callout at `dashboard/index.tsx:405`; `DesignRunView` returns a synthetic
   error response that renders in the response viewer; `:99` is a self-healing
   reconnect with nothing to tell the user. Adding toasts there would
   double-report. No change made.
7. **Dead-end strings.** No toast can offer an action.
8. **No documentation.** `docs/design-system.md` has no toast section.

## Decisions taken

- **Build on the shadcn/Radix Toast primitive.** `@radix-ui/react-toast` is
  added and `components/ui/toast.tsx` is created in the shadcn shape, styled
  with Vayu tokens.

  The app is already a shadcn project (`components.json`, twelve Radix packages,
  `ui/index.ts` says "Re-exported from shadcn/ui with Vayu theming") and every
  other overlay - dialog, popover, select, dropdown, tooltip - is a Radix
  primitive. The toast was the one hand-rolled exception, and it sits in
  `components/shared/` rather than `components/ui/` because it was never
  installed as one.

  **The superseded decision is rewritten, not left to rot.** The store's header
  currently reads "Kept in-house (rather than a toast library) so toasts render
  through the app's design tokens." That sentence stops being true the moment
  this lands, and a stale rationale comment is worse than none - a later reader
  would take it as a constraint. It is replaced with the reasoning that actually
  applies:

  > This store previously carried its own 4s `setTimeout` and a note that the
  > toast was "kept in-house (rather than a toast library) so toasts render
  > through the app's design tokens". The token concern was right and still
  > holds - it just never required hand-rolling. A shadcn primitive is source in
  > this repo wearing our own token classes, exactly like `dialog.tsx` and
  > `popover.tsx`; taken literally the old note would have ruled those out too.
  > What it actually ruled out was a library shipping its own CSS, which is
  > still why `sonner` was not adopted.

  The distinction the old wording missed: "no library" was never the goal, "no
  vendor stylesheet" was.

  Rejected: `sonner`, which shadcn's docs now recommend, because it ships its
  own CSS to re-theme and is furthest from the existing setup. Rejected:
  continuing hand-rolled, because roughly 150 lines of timer, pause, swipe and
  exit-animation code would be written by hand to reach where the primitive
  starts.
- **Full unification onto toasts.** Every failure - including save failures -
  is reported by a toast. The Dock's error line is removed.

  This was raised as a concern and reaffirmed by the user. Recorded because the
  Dock line was a deliberate recent fix (one of the "written but never read"
  defects) guarded by `Dock.save-error.test.tsx`; that guard is replaced, not
  deleted, by an equivalent one on the new channel. The cost accepted is that a
  background auto-save failure becomes transient rather than persistent.
- **Cheap actions only.** Ship the action API and wire only actions needing no
  new plumbing. Cross-module navigation (the OAuth "open the Auth tab" case) is
  left for a follow-up.

## Design

### 0. What the primitive provides

Choosing Radix removes work rather than adding it. Verified against the Radix
Toast documentation:

| Need | Source |
|------|--------|
| Auto-dismiss timer | `Toast.Root duration` (provider default 5000ms) |
| Pause on hover, focus **and window blur** | built in |
| Swipe to dismiss | built in, `swipeDirection` / `swipeThreshold` |
| Exit animation | `data-state="open" \| "closed"` |
| Jump focus to the toasts | `Toast.Provider hotkey`, default `F8` |
| Announcement politeness | `Toast.Root type="foreground" \| "background"` |

Window-blur pausing and the F8 hotkey are both better than the hand-rolled plan,
and the hotkey is the keyboard affordance this file most lacked.

`data-state` means the exit animation uses the same `tw-animate-css` classes as
`dialog.tsx`, `popover.tsx` and `select.tsx` already do, so the two-phase
"mark exiting, drop later" hack the hand-rolled design needed is gone.

Everything in the table is therefore **removed from the store's
responsibilities**: no `setTimeout`, no `pauseTimers` / `resumeTimers`, no
`expiresAt` bookkeeping.

### 1. Store - `toast-store.ts`

The string form keeps working, so no call site is forced to change:

```ts
showToast("Run history cleared", "success");
showToast({ title, message, variant, action, duration }); // returns the id
```

Shape:

```ts
export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface Toast {
	id: string;
	title?: string;
	message: string;
	variant: ToastVariant;
	action?: ToastAction;
	duration: number;
}
```

The store becomes a **pure queue** - add, remove, and the two policies Radix has
no opinion about:

- **Per-variant durations.** `info` / `success` 4s, `warning` 6s, `error` 10s,
  passed straight to `Toast.Root duration`. A failure needs longer than a
  confirmation; the primitive's hover/focus/blur pausing covers the rest.
- **Dedup.** An identical `message` + `variant` already on screen is not
  stacked; its entry is re-inserted so the primitive restarts its timer. The
  OAuth guard and SSE paths can fire repeatedly.
- **Cap of 4**, oldest evicted, so a burst cannot run off-screen.
- **`dismissAll()`**.

Removal is driven by `Toast.Root onOpenChange(false)`, which the primitive fires
for timeout, close button and swipe alike - so there is one removal path rather
than three.

`warning` ships with real writers - the two "A load test is already running"
call sites in `request-builder/index.tsx` (360, 377) move to it. A refusal is
not the same event as an error, and today they render identically.

### 2. Components - `ui/toast.tsx` and `shared/Toaster.tsx`

Two files, matching how the app already splits primitives from shell:

- **`components/ui/toast.tsx`** - the shadcn primitive. Re-exports
  `ToastProvider`, `ToastViewport`, `Toast`, `ToastTitle`, `ToastDescription`,
  `ToastAction`, `ToastClose`, with a `cva` variant map over Vayu tokens.
  Exported from `ui/index.ts` like every other primitive.
- **`components/shared/Toaster.tsx`** - keeps its path, and keeps its job:
  subscribe to the store and render one `<Toast>` per entry. It stops owning
  timers and ARIA.

Per toast: a variant icon, an optional `ToastTitle`, the message as
`ToastDescription`, an optional `ToastAction`, a left accent rail in the
variant's status token, and a `ToastClose` with `p-1 -m-1` hit padding, a radius
token and a `focus-visible` ring.

`prefers-reduced-motion` needs no new work - `index.css:1110` already collapses
all animation globally, and `reduced-motion.test.ts` guards it.

#### The accessibility contract - what carries over, and what must be re-verified

This is the real cost of the decision and the part most likely to go wrong.

The current `Toaster.tsx` carries 40 lines of rationale over 30 lines of code,
and six tests asserting `role="status"`, `aria-live="polite"` and an explicit
`aria-atomic="false"` **on the container**. Radix does not use that shape. Those
six assertions will not hold, and the tests are rewritten.

Two things must survive the swap, and they are different in kind:

1. **The decision that everything is polite, nothing assertive.** The existing
   comment argues it: a toast auto-dismisses on a timer, and every toast here
   reports the outcome of an action the user just took, so interrupting is the
   wrong trade. That reasoning is unchanged by the primitive, and it maps onto
   Radix's `type` prop - **every toast uses `type="background"`**, including
   errors. The rationale comment moves to the new file rather than being
   deleted; it is the record of a decision, not a description of the old code.
2. **The guarantee that a toast is actually announced.** The old code earned
   this the hard way (a region that appears with its content is commonly not
   announced at all). Radix has its own solution to the same problem.

**Verification, not assumption.** The Radix documentation describes the
announcement model but does not pin the rendered elements or attributes, and
this design deliberately does not guess them. The implementation step is:
render the primitive in jsdom, inspect the actual DOM, and write the new tests
against what is observed. If the observed behaviour does not preserve
guarantee 2, that is a finding to report rather than paper over.

Note the standing guidance that screen-reader work is deprioritised for this
desktop tool: the goal here is **not to add ARIA**, it is to not silently lose a
property the codebase already paid for. The keyboard and contrast wins - F8,
the focus ring, the real hit target, icon-plus-colour instead of colour alone -
are the parts that carry direct value.

### 3. Tokens

One family for all four variants: `--status-success`, `--status-error`,
`--status-warning` for the icon and rail, `--muted-foreground` for `info`.
`border-destructive/40` goes.

Per CLAUDE.md, the three status tokens are not interchangeable: `--status-*` for
the icon and rail, `--status-*-text` where the colour *is* the text, and
`--status-*-fill` only under a white label. Guarded by
`status-color-tokens.test.ts`.

The toast keeps `bg-popover` and a `border-border` edge. That edge faces the
canvas, which is the case CLAUDE.md calls correct for `border-border`; it is not
a `border-rule` candidate, since no `surface-popover` class is declared and
`border-rule` under no declared surface falls back to the invisible default.

### 4. The unification

`failSave(message)` becomes the bridge: it sets `status: "error"` **and** fires
an error toast carrying the reason. Every existing caller then reports through
the toast channel with no call-site churn and no missed sites.

Consequently `errorMessage` is **removed** from `save-store`, because after the
Dock line goes nothing reads it. The chain is already partly dead: the
`useSaveManager` re-export (`useSaveManager.ts:46,58,243`) has no consumer -
`RequestBuilderProvider.tsx:247` takes `status` only. Leaving the field in place
would recreate the exact "written but never read" defect this codebase keeps
hitting. `clearError` reduces to a status reset.

The Dock keeps its `saving` / `saved` states and loses only the error span.

No new toasts for the paths defect 6 named: they were already reported
elsewhere, and a second surface would double-report.

### 5. Tests

New behaviour is tested by **rendering and asserting `element.className`**, not
by scanning source. The variant classes arrive through a
`toast.variant === "error" && "..."` binding, and a source scan cannot see a
class that arrives in a variable - the badge-hover lesson.

- Variant styling: each of the four renders its own icon and rail class, and
  none of them uses a `-fill` token as a foreground.
- Dedup: the same message twice yields one toast.
- Cap: a fifth toast evicts the oldest.
- Action: the button renders, fires `onClick`, and dismisses.
- Removal: `onOpenChange(false)` drops the entry from the store.
- Rewritten a11y tests, derived from the primitive's **observed** DOM rather
  than from the old hand-rolled shape, asserting the announcement guarantee and
  that every toast is `type="background"`.
- Replacement for `Dock.save-error.test.tsx`: `failSave("database is locked")`
  produces a toast whose text contains the reason, and the Dock no longer
  renders an error span. Same guarantee - a failure says *why* - moved to the
  new channel.
- `CollectionTree.mutation-error.test.tsx` is updated from asserting
  `saveStore.errorMessage` to asserting the toast.

Each new guard is mutation-checked: revert the fix, confirm it fails, restore.

### 6. Docs

- `docs/design-system.md` gains a Toast section: variants and their tokens,
  durations, the cap and dedup rules, and the persistent-viewport constraint.
  Values are checked against `index.css` by `design-system-doc.test.ts`.
- `docs/app/state-management.md`: the toast store's new API and the `failSave`
  bridge.
- `docs/app/COMPONENTS.md` if the component surface changes shape.

No em-dashes; ` - ` throughout. Format only files touched that were already
prettier-clean.

## Out of scope

- `sonner`, and any runtime toast library other than the Radix primitive.
- The OAuth "open the Auth tab" navigation action.
- A notification history or centre.
- Native OS notifications (`app/electron/` has no `Notification` surface today).
- Migrating other overlays; only the toast changes.

## Acceptance

- Error and success are distinguishable in **both** themes by icon and rail, not
  only by a 40%-alpha border.
- A failed collection delete says why, and does not say "Save failed".
- Nothing writes a field no layer reads.
- The announcement guarantee is re-verified against the primitive's observed
  DOM, and every toast is `type="background"`.
- The dismiss control has a visible focus ring and a hit target larger than its
  14px icon; `F8` moves focus to the viewport.
- `pnpm test`, `pnpm type-check`, `pnpm lint`, `pnpm format:check` green.

## Risks

- **The a11y swap is the one-way door.** If the primitive's observed behaviour
  does not preserve the announcement guarantee, stop and report rather than
  shipping a quieter toast than the one being replaced.
- **A new runtime dependency** (`@radix-ui/react-toast`) ships in the app
  bundle. Consistent with the twelve Radix packages already present.
- **`save-store` will import `toast-store`**, coupling two stores. Accepted
  because the alternative - editing eight call sites - risks missing one, and a
  missed site is a silently unreported failure.
