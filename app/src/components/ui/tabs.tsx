/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tabs - Vayu's section tabs.
 *
 * The look is "ghost": no band rule, no fill, no pill. The active trigger is
 * `--primary-text` at weight 600; the rest are `--muted-foreground` at 500.
 *
 * **Why `--primary-text` and not `--primary`.** What separates an active tab
 * from an inactive one here is almost entirely *saturation*, not lightness -
 * measured on `--card`, the two sit within a 1.01-1.56 contrast ratio in every
 * accent scheme, which is to say the same brightness. That is fine while the
 * accent is saturated (55-95% against an inactive 4-5%) and fails completely
 * for `graphite`, the one desaturated scheme, where it is grey on grey. The
 * token carries that exception; see the note in `index.css`.
 *
 * **Why the labels are wrapped.** The active state is partly a weight change,
 * and a bare `data-[state=active]:font-semibold` widens the trigger, so
 * switching tab shoves its neighbours sideways. `CollectionDetail` shipped that
 * bug. `TabLabel` reserves the bold width up front, in the primitive, so no
 * call site can reintroduce it. `MARK_SLOT` further down is the same idea for
 * the other half of a trigger's width: a count or an error dot that mounts
 * widens its trigger and shoves its neighbours, so the slot is always there and
 * only its contents change.
 *
 * This file previously shipped shadcn's segmented-pill default, which four of
 * the five call sites immediately undid with `h-auto p-0 bg-transparent` before
 * re-declaring their own underline recipe. There is one *trigger* look now.
 *
 * **The strip's chrome is a `variant`, and it is required.** The triggers were
 * shared while the band around them was not: seven call sites carried seven
 * recipes - `mx-5 mt-3`, nothing at all, `w-full px-1`, `px-5` with a
 * `border-b bg-panel`, `w-full px-4`, `bg-panel px-4`, and
 * `px-3 py-1.5 border-b border-rule bg-muted/30`. Three chromes exist, and the
 * prop has no default so a new strip has to say which one it is rather than
 * inheriting whichever happened to be first:
 *
 * - `pane` - the strip *is* the pane's chrome band: `bg-panel px-4` with the
 *   bottom rule the content hangs from. The dashboard, Collection Detail and
 *   the unified response viewer.
 * - `inset` - a strip inside content that is already padded, so it carries
 *   only enough padding to keep the first trigger's focus ring off the edge
 *   (`px-1`). The request strip, the import dialog, the load-test detail.
 * - `bare` - the band belongs to a parent row that holds other things beside
 *   the tabs (the response pane's strip shares its row with the status and the
 *   actions), so the list adds no fill, no rule and no padding of its own.
 *   Not a fourth look: it is `pane`, drawn by whoever owns the row.
 *
 * `border-rule` rather than a border token, and no surface class beside it:
 * `bg-panel` is the `:root` default surface, which is the one case where the
 * fallback value is the right answer (`docs/design-system.md`, "`border-rule`:
 * let the surface pick the token").
 */

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/** Band height. `xs` is 24px, `sm` is 28px; both are `text-xs`. */
type TabSize = "xs" | "sm";

/*
 * `px-2`, not `px-2.5`. Measured: the response strip is 465px of triggers at
 * `px-2.5` and 437px at `px-2`, and the request strip 532px against 500px. The
 * response pane got seven permanent tabs when the conditional ones were removed,
 * and the request strip has carried eight for a while - at a 50/50 split neither
 * had the room, so both scrolled.
 *
 * Vertical padding is untouched: `xs` is still a 24px band and `sm` a 28px one,
 * which is the step the rest of the app is built on.
 */
const SIZE: Record<TabSize, string> = {
	xs: "px-2 py-1",
	sm: "px-3 py-1.5",
};

const TabsSizeContext = React.createContext<TabSize>("xs");

/**
 * The strip's chrome. See the file comment for what each one is for; the prop
 * is required, so there is no "whatever the first caller wanted" default.
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
				// `ring-inset`, because a trigger fills its list's height exactly and
				// the scrolling strips are `overflow-y-hidden` - an outward ring had
				// no room and rendered as two clipped vertical strokes. Inset also
				// keeps the fix on the trigger, where the ring is, rather than
				// asking every present and future tab strip to leave room for it.
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				// Every state change here is a `data-[state=]` variant rather than a
				// swapped class, so the class list is identical either way and only
				// the attribute moves. Paired with TabLabel, activating a tab
				// changes nothing that affects layout.
				"data-[state=active]:text-primary-text data-[state=active]:font-semibold",
				// The indicator. Absolutely positioned inside the existing bottom
				// padding, so it adds no height - the band stays 24px.
				//
				// Colour and weight alone are not enough, and graphite is the proof:
				// its accent is a neutral, so the active label differs from an
				// inactive one only in lightness, and 12px at 600 against 500 is a
				// difference you have to go looking for. A rule is a *shape*, which
				// no accent scheme can wash out. `--primary` rather than
				// `--primary-text` because this is an indicator, not a label - the
				// split the design system already draws.
				"after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full",
				// `after:transition-colors` on its own: the trigger's own
				// `transition-colors` above only covers the trigger's own box, not
				// this pseudo-element's separately painted background - without it
				// the underline pops in/out instantly on tab switch instead of
				// fading with everything else.
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
				// Radix's `forceMount` means "always present", not "present but
				// hidden": it makes `present` unconditionally true and the panel's
				// `hidden` attribute is `!present`, so a force-mounted inactive
				// panel carries no `hidden` and paints straight over the selected
				// one. Collection Detail force-mounts four panels to keep unsaved
				// drafts alive and stacked all of them on screen at once.
				//
				// Hiding belongs here rather than at the call site for the same
				// reason TabLabel's width reservation does - a caller reaching for
				// `forceMount` is thinking about the draft it is protecting, not
				// about Radix's presence model. Inert for a panel that is not
				// force-mounted, since Radix never renders one.
				"data-[state=inactive]:hidden",
				// `.enter-fade` here is `display: none -> block`, not a fresh DOM
				// node - `@starting-style` fires on either, per spec ("a change of
				// display type, such as from none to something else"), so switching
				// back to an already-visited tab fades in exactly like the first
				// visit. A force-mounted panel (Collection Detail's four) gets this
				// too: it never truly unmounts, only its `hidden` attribute flips,
				// which is the same display-type change.
				"enter-fade",
				className
			)}
			{...props}
		/>
	);
}

/**
 * A tab label that always occupies the width of its own bold form.
 *
 * The visible text and a hidden `font-semibold` copy share one grid cell, so
 * the column is sized by the wider of the two - which is the bold one, in every
 * state. Without this, `data-[state=active]:font-semibold` makes the active
 * trigger grow and every trigger to its right jump.
 *
 * Takes a `string` rather than `ReactNode` on purpose: the reservation only
 * works if the hidden copy renders the same text, and a node could carry its
 * own state or side effects when duplicated.
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
 * The slot a trailing mark on a trigger sits in - the count, the error dot.
 *
 * **Why the slot is reserved, and not just the mark's contents.** A mark is a
 * flex item on the trigger; the trigger is `shrink-0` inside a `flex-nowrap`
 * list. So a mark that *mounts* widens its own trigger by its own width plus
 * the trigger's `gap-1.5`, and every trigger to its right moves along with it -
 * and so does whatever else shares the row (the request strip's `Table`
 * toggle). Typing the first character into an empty Params table moved the
 * seven tabs after Params and the toggle past them. This is the same defect
 * `TabLabel` above fixes for the active weight, arriving through content
 * instead of through a class.
 *
 * `TabLabel`'s own trick - a hidden copy at the widest state - does not
 * transfer, because a count has no widest state: it is a number, not one
 * string rendered two ways. So the slot is held open instead, and the mark
 * empties rather than unmounting.
 *
 * `1ch`, in the `font-mono` `text-micro` this sets: one `ch` there *is* one
 * digit, whatever the font scale resolves that to, and in a monospace face
 * every digit has the same advance. A pixel or `rem` literal would be a
 * number nudged until it
 * looked right, and would drift the moment the micro step moved. Both marks
 * carry the same class so the Console tab's either/or (dot *or* count) is
 * width-neutral too, which a `size-[5px]` dot beside a `1ch` count is not.
 *
 * `min-w`, not `w`: a count crossing 9 to 10 is content genuinely growing, and
 * a pinned slot would clip it. That transition still moves the triggers to its
 * right, by one digit, and is left that way on purpose - reserving two digits
 * would cost that width permanently on every counted tab, on strips that
 * already scroll at seven and eight tabs (see SIZE). The transition worth
 * spending width on is nothing-to-something, which every counted tab makes and
 * most make often; nine-to-ten is a tab strip most requests never reach.
 */
const MARK_SLOT = "min-w-[1ch] text-center font-mono text-micro leading-none";

/**
 * The small superscript count on a tab.
 *
 * A superscript rather than the `h-5` `Badge` pill this replaces: the pill set
 * a 20px floor that no 24px band can accommodate, and it was the single reason
 * the old triggers had to stay 38px tall. This sets no height at all.
 *
 * 10px is the documented micro step - see type-scale.test.ts, which rejects the
 * half-pixel sizes that come from nudging a number until it looks right.
 *
 * **Zero renders nothing, and so does `undefined`.** A count is there to say
 * "there are this many"; a `0` says "there are none", which the tab's own empty
 * state already says at more length and without asking you to read a
 * superscript to find out there is nothing to read. The Console tab showed one
 * the moment its gating was removed and it always rendered - a `0` beside a tab
 * whose panel says "No console output".
 *
 * Handled here rather than at each call site because the call sites were
 * already working around it by hand: `RequestTabs` passed `badge: undefined`
 * and guarded with `tab.badge !== undefined`, which is the same remembering
 * problem one level up. A caller that genuinely wants to show a zero can pass
 * the string `"0"`.
 *
 * **"Renders nothing" means nothing *perceptible*, not nothing at all.** The
 * `<sup>` is always here, holding `MARK_SLOT` open; only its contents come and
 * go, so a count appearing shifts no sibling. It is empty, not `0` and not a
 * placeholder glyph, so it contributes no text to the trigger's accessible
 * name and a screen reader reads "Params", not "Params 0".
 *
 * The contract that follows for callers: render `TabCount` **unconditionally**
 * on any tab that can carry a count, passing `undefined` when it has none -
 * gating the element is what reintroduces the shift. A tab that can never
 * carry one renders no `TabCount` at all and pays no reserved width.
 */
function TabCount({ value, className }: { value?: React.ReactNode; className?: string }) {
	const shown = value === 0 || value === undefined || value === null ? null : value;

	return (
		<sup
			data-slot="tab-count"
			className={cn(MARK_SLOT, "tabular-nums text-primary-text", className)}
		>
			{/*
			 * The fade rides the value, not the slot. `.enter-fade` is a mount
			 * effect (`@starting-style`), and the slot no longer mounts - so the
			 * span that does carries it, and a count appearing still fades in
			 * rather than popping. React keeps this node across a 1 -> 2, so only
			 * absent-to-present fades, which is the transition worth marking.
			 */}
			{shown === null ? null : <span className="enter-fade">{shown}</span>}
		</sup>
	);
}

/**
 * An error mark on a tab.
 *
 * Deliberately *not* a `TabCount`. The response Console tab used to draw its
 * script-error state in the count slot, so turning counts off would have
 * silently deleted the only signal that a script failed. Keeping the mark its
 * own element means the two can be controlled separately.
 *
 * It shares `MARK_SLOT` with the count, and the 5px dot centres inside it: its
 * one call site swaps the two on the same trigger, so a bare 5px dot standing
 * where a `1ch` count stood would move the tabs to its right every time a
 * script failed.
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
			className={cn(MARK_SLOT, "inline-flex items-center justify-center", className)}
		>
			<span
				role="img"
				aria-label={label}
				title={label}
				className="size-[5px] shrink-0 rounded-full bg-status-error enter-fade"
			/>
		</span>
	);
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabLabel, TabCount, TabErrorDot };
export type { TabsVariant };
