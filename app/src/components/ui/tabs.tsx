/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Vayu's section tabs, "ghost": no band rule, no fill, no pill. The active trigger is
 * `--primary-text` at 600, the rest `--muted-foreground` at 500.
 *
 * **`--primary-text`, not `--primary`**: active and inactive differ almost only in *saturation*
 * (measured on `--card`, 1.01-1.56 contrast in every accent scheme), fine for a saturated accent
 * (55-95% against an inactive 4-5%) and grey on grey for `graphite`, the desaturated one. The token
 * carries that exception (see `index.css`).
 *
 * **The labels are wrapped**: a bare `data-[state=active]:font-semibold` widens the trigger and
 * shoves its neighbours (`CollectionDetail` shipped that), so `TabLabel` reserves the bold width in
 * the primitive. `MARK_TRACK` answers the same for a count or error dot, whose track animates open
 * from zero instead of jumping.
 *
 * **The strip's chrome is a required `variant`**, with no default, so a new strip says which it is
 * rather than inheriting the first caller's (seven call sites had seven recipes):
 *
 * - `pane` - the strip *is* the pane's chrome band: `bg-panel px-4` with the bottom rule the
 *   content hangs from. The dashboard, Collection Detail, the response viewer.
 * - `inset` - inside already-padded content, so only enough padding (`px-1`) to keep the first
 *   trigger's focus ring off the edge. The request strip, the import dialog, the load-test detail.
 * - `bare` - the band belongs to a parent row holding other things (the response strip shares its
 *   row with status and actions), so the list adds no fill, rule or padding: `pane`, drawn by the
 *   row's owner.
 *
 * `border-rule`, with no surface class beside it: `bg-panel` is the `:root` default surface, the
 * one case where the fallback is right (`docs/design-system/surfaces.md`, "`border-rule`: let the
 * surface pick the token").
 */

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import { useHeldValue } from "@/hooks/useHeldValue";

const Tabs = TabsPrimitive.Root;

/** Band height. `xs` is 24px, `sm` is 28px; both are `text-xs`. */
type TabSize = "xs" | "sm";

/*
 * `px-2`, not `px-2.5`: measured at seven tabs, 465px against 437px of triggers on the response
 * strip, 532px against 500px on the request strip. Both carry eight and neither fits a ~430px pane,
 * so they fit-and-overflow (`useFittedTabs`) rather than scroll, and the saved pixels are tabs kept
 * out of the "+N" menu. `naturalTriggerWidth` budgets this padding, so the two move together.
 * Vertical padding is unchanged: `xs` a 24px band, `sm` 28px, the app's step.
 */
const SIZE: Record<TabSize, string> = {
	xs: "px-2 py-1",
	sm: "px-3 py-1.5",
};

const TabsSizeContext = React.createContext<TabSize>("xs");

/**
 * The strip's chrome (the file header says what each is for); required, so there is no first-caller
 * default.
 */
type TabsVariant = "pane" | "inset" | "bare";

const VARIANT: Record<TabsVariant, string> = {
	pane: "border-b border-rule bg-panel px-4",
	inset: "px-1",
	bare: "",
};

function TabsList({
	className,
	size = "xs",
	variant,
	...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
	size?: TabSize;
	variant: TabsVariant;
}) {
	return (
		<TabsSizeContext.Provider value={size}>
			<TabsPrimitive.List
				data-slot="tabs-list"
				data-variant={variant}
				className={cn(
					"flex min-w-0 items-stretch gap-0.5 bg-transparent",
					VARIANT[variant],
					className
				)}
				{...props}
			/>
		</TabsSizeContext.Provider>
	);
}

function TabsTrigger({
	className,
	size,
	...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & { size?: TabSize }) {
	const inherited = React.useContext(TabsSizeContext);
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm",
				"text-xs font-medium text-muted-foreground",
				"ring-offset-background transition-colors",
				"hover:text-foreground",
				// `ring-inset`: a trigger fills its list's height and the strips are
				// `overflow-hidden`, so an outward ring rendered as two clipped strokes. Inset
				// keeps the fix on the trigger, not on every strip leaving room.
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				// Every state change is a `data-[state=]` variant, not a swapped class, so only the
				// attribute moves; with TabLabel, activating a tab changes nothing affecting
				// layout.
				"data-[state=active]:text-primary-text data-[state=active]:font-semibold",
				// The indicator, absolutely positioned in the bottom padding, so the band stays
				// 24px. Colour and weight are not enough: graphite's accent is a neutral, so the
				// active label differs only in lightness, and 12px at 600 against 500 is hard to
				// see. A rule is a *shape* no scheme washes out. `--primary`, not `--primary-text`:
				// an indicator, not a label.
				"after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full",
				// `after:transition-colors` of its own: the trigger's `transition-colors` covers
				// its box, not this pseudo-element's background, which would otherwise pop on a
				// switch.
				"after:bg-transparent after:transition-colors data-[state=active]:after:bg-primary",
				SIZE[size ?? inherited],
				className
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
	return (
		<TabsPrimitive.Content
			data-slot="tabs-content"
			className={cn(
				"ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				// Radix's `forceMount` means "always present", not "present but hidden": `present`
				// is true and `hidden` is `!present`, so a force-mounted inactive panel paints over
				// the selected one (Collection Detail force-mounts four to keep drafts alive).
				// Hidden here, not per call site, as with TabLabel: a caller reaching for
				// `forceMount` is thinking of its draft, not Radix's presence model. Inert for a
				// panel not force-mounted, which Radix never renders.
				"data-[state=inactive]:hidden",
				// `.enter-fade` here is `display: none -> block`, not a fresh node:
				// `@starting-style` fires on either (per spec, "a change of display type"), so a
				// revisited tab fades like the first visit, and a force-mounted panel, whose
				// `hidden` only flips, does too.
				"enter-fade",
				className
			)}
			{...props}
		/>
	);
}

/**
 * A tab label occupying its bold form's width: the text and a hidden `font-semibold` copy share one
 * grid cell, sized by the bold one in every state, so the active trigger never grows and shifts the
 * rest. A `string`, not `ReactNode`: the hidden copy must render the same text, and a duplicated
 * node could carry its own state or effects.
 */
function TabLabel({ children }: { children: string }) {
	return (
		<span className="grid">
			<span
				data-slot="tab-label-reserve"
				aria-hidden="true"
				className="invisible col-start-1 row-start-1 h-0 font-semibold"
			>
				{children}
			</span>
			<span className="col-start-1 row-start-1">{children}</span>
		</span>
	);
}

/*
 * The track a trigger's trailing mark (the count, the error dot) animates into. A mark is a flex
 * item on a `shrink-0` trigger in a `flex-nowrap` list, so one *mounting* at full width widens its
 * trigger and jumps every trigger to its right and whatever shares the row (the request strip's
 * `Table` toggle): typing into an empty Params table moved seven tabs and the toggle. `TabLabel`'s
 * defect, through content. A reserved `min-w-[1ch]` slot (plus the trigger's `gap-1.5`) would
 * charge every countable tab on every strip, room a strip already overflowing at seven or eight
 * tabs (see SIZE) cannot spare. So the track animates `grid-template-columns: 0fr -> 1fr`: `0fr` is
 * zero, `1fr` the content's width, both real track sizes a transition interpolates, unlike `auto`.
 * `grid-cols-*` carries the width, `overflow-hidden` clips mid-transition, and `-ms-1.5`/`ms-0`
 * cancels and restores the trigger's `gap-1.5` in step, so an empty mark costs nothing, not even
 * its gap; the two `transition-[...]` properties move together for that. `TabLabel`'s hidden copy
 * does not transfer: a count has no widest state.
 */
const MARK_TRACK =
	"grid overflow-hidden transition-[grid-template-columns,margin-inline-start] duration-150 ease-out";

/** The dot `TabCount` draws in `presence` mode; decorative, so never named. */
function PresenceDot() {
	return (
		<span
			aria-hidden="true"
			data-slot="tab-presence-dot"
			className="size-[5px] shrink-0 rounded-full bg-primary-text"
		/>
	);
}

/**
 * The small superscript count on a tab, not a `Badge` pill, whose `h-5` 20px floor no 24px band
 * holds; it sets no height. 10px is the micro step (`type-scale.test.ts` rejects nudged half-pixel
 * sizes).
 *
 * **Zero and `undefined` render nothing**, here so no call site must remember: `0` says "none",
 * which the tab's empty state says better. A caller wanting a zero passes `"0"`. Nothing
 * *perceptible*: the `<sup>` stays at a `grid-cols-[0fr]` track (`MARK_TRACK`) and only its
 * contents and track size change, so a count grows in, costs nothing at rest, and adds no text to
 * the accessible name ("Params", not "Params 0").
 *
 * **Going empty is held** (`useHeldValue`, `TIMING.MARK_FADE_MS`): the last count stays one track
 * duration while opacity takes it out, so exit mirrors entry rather than the track collapsing
 * around an emptied box.
 *
 * So callers render `TabCount` **unconditionally** on a tab that can carry a count, passing
 * `undefined` for none; gating the element brings the shift back. A tab that never carries one
 * renders none and pays no width.
 *
 * **`presence` draws a dot instead of the value** (#2199), for a tab with "something here" and
 * nothing to count (Info, Body, Auth, Settings), so it is not read as a count of one beside Params'
 * and Headers' real numbers. Any non-empty `value` means present. Same track, held exit and render
 * contract; the dot is `aria-hidden` and the cell holds no text, so the accessible name stays the
 * bare label.
 */
function TabCount({
	value,
	presence = false,
	className,
}: {
	value?: number | string | null;
	presence?: boolean;
	className?: string;
}) {
	const live = value === 0 || value === undefined || value === null ? null : value;
	/*
	 * The track reads `live`, the text `shown`, so the collapse starts on time while the digit it
	 * collapses around is still there to fade (`useHeldValue`).
	 */
	const { shown, fading } = useHeldValue(live, TIMING.MARK_FADE_MS);

	return (
		<sup
			data-slot="tab-count"
			data-presence={presence ? "" : undefined}
			className={cn(
				MARK_TRACK,
				live === null ? "grid-cols-[0fr] -ms-1.5" : "grid-cols-[1fr] ms-0"
			)}
		>
			<span
				className={cn(
					"min-w-0 text-center font-mono text-micro leading-none tabular-nums text-primary-text",
					// `shown === null` as well as `fading`, so an empty cell rests at zero rather
					// than transitioning to full opacity behind a collapsed track, and entry
					// mirrors exit (a count fades up as its track opens). Not on first paint, where
					// `shown` starts live.
					"transition-opacity duration-150 ease-out",
					shown === null || fading ? "opacity-0" : "opacity-100",
					// `1em` is a digit's line (`leading-none` at the micro step), so the dot sits
					// at its centre.
					presence && "flex h-[1em] items-center justify-center",
					className
				)}
			>
				{presence ? shown !== null && <PresenceDot /> : shown}
			</span>
		</sup>
	);
}

/**
 * An error mark on a tab, not a `TabCount`, so turning counts off cannot delete the only sign a
 * script failed. It shares `MARK_TRACK` but is not kept mounted: its call sites mount it outright
 * (the response Console tab swaps it in for a `TabCount`, the overflow menu adds it when a hidden
 * tab needs attention). `transition-*` animates only a change on an element already in the DOM, so
 * a real mount needs `starting:` (`@starting-style`) for a "before" frame, as `.enter-fade` does.
 */
function TabErrorDot({
	label = "Script error",
	className,
}: {
	label?: string;
	className?: string;
}) {
	return (
		<span
			data-slot="tab-error-dot"
			className={cn(
				MARK_TRACK,
				"starting:grid-cols-[0fr] starting:-ms-1.5 grid-cols-[1fr] ms-0"
			)}
		>
			<span className="flex min-w-0 items-center justify-center">
				<span
					role="img"
					aria-label={label}
					title={label}
					className={cn("size-[5px] shrink-0 rounded-full bg-status-error", className)}
				/>
			</span>
		</span>
	);
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabLabel, TabCount, TabErrorDot };
export type { TabsVariant };
