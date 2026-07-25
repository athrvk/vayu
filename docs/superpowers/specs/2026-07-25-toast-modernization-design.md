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
6. **Genuinely silent paths.** `DesignRunView.tsx:258` (replay failed),
   `dashboard/index.tsx:99` and `:128` log to console and nothing else.
7. **Dead-end strings.** No toast can offer an action.
8. **No documentation.** `docs/design-system.md` has no toast section.

## Decisions taken

- **Stay in-house.** The store's header comment records this as deliberate, so
  toasts render through the app's design tokens. Modernize rather than adopt
  sonner. No new dependency, no vendor CSS to re-theme, and the a11y work and
  its six tests survive.
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
	expiresAt: number;
}
```

Behaviour:

- **Per-variant durations.** `info` / `success` 4s, `warning` 6s, `error` 10s. A
  failure needs longer than a confirmation; hover-pause covers the rest.
- **Dedup.** An identical `message` + `variant` already on screen refreshes its
  timer instead of stacking. The OAuth guard and SSE paths can fire repeatedly.
- **Cap of 4**, oldest evicted, so a burst cannot run off-screen.
- **`pauseTimers()` / `resumeTimers()`** for hover. Timers live in a
  module-level `Map` keyed by id; pausing stores the remaining ms, resuming
  re-arms from it. Testable with fake timers.
- **`dismissAll()`**.
- Dismissing early clears the pending timeout rather than leaving it to fire.

`warning` ships with real writers - the two "A load test is already running"
call sites in `request-builder/index.tsx` (360, 377) move to it. A refusal is
not the same event as an error, and today they render identically.

### 2. Component - `Toaster.tsx`

The viewport element and every ARIA attribute stay byte-identical. All six
existing tests must pass **unmodified** - that is the acceptance check on this
section.

Per toast, added: a variant icon, an optional bold title, an optional action
button, a left accent rail in the variant's status token, enter/exit animation,
hover-to-pause on the viewport, and a dismiss button with `p-1 -m-1` hit
padding, a radius token and a `focus-visible` ring.

Exit animation needs the toast to outlive its removal, so dismissal is two
phase: mark `exiting`, drop after the animation duration.

`prefers-reduced-motion` needs no new work - `index.css:1110` already collapses
all animation globally, and `reduced-motion.test.ts` guards it.

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

Silent paths gain toasts: `DesignRunView.tsx:258`, `dashboard/index.tsx:99`
and `:128`.

### 5. Tests

New behaviour is tested by **rendering and asserting `element.className`**, not
by scanning source. The variant classes arrive through a
`toast.variant === "error" && "..."` binding, and a source scan cannot see a
class that arrives in a variable - the badge-hover lesson.

- Variant styling: each of the four renders its own icon and rail class.
- Dedup: the same message twice yields one toast with a refreshed timer.
- Cap: a fifth toast evicts the oldest.
- Pause/resume: fake timers, hover holds a toast past its duration.
- Action: the button renders, fires `onClick`, and dismisses.
- Dismiss clears the pending timer.
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

- Swapping in a toast library.
- The OAuth "open the Auth tab" navigation action.
- A notification history or centre.
- Native OS notifications (`app/electron/` has no `Notification` surface today).

## Acceptance

- The six existing `Toaster.test.tsx` tests pass unmodified.
- Error and success are distinguishable in **both** themes by icon and rail, not
  only by a 40%-alpha border.
- A failed collection delete says why, and does not say "Save failed".
- Nothing writes a field no layer reads.
- `pnpm test`, `pnpm type-check`, `pnpm lint`, `pnpm format:check` green.
