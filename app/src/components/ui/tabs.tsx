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
 * call site can reintroduce it.
 *
 * This file previously shipped shadcn's segmented-pill default, which four of
 * the five call sites immediately undid with `h-auto p-0 bg-transparent` before
 * re-declaring their own underline recipe. There is one look now, and no
 * `variant` prop: the segmented option had exactly one consumer and this change
 * converts it. Add the prop back when a real second look turns up with a caller
 * to justify its shape.
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

function TabsList({
	className,
	size = "xs",
	...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { size?: TabSize }) {
	return (
		<TabsSizeContext.Provider value={size}>
			<TabsPrimitive.List
				data-slot="tabs-list"
				className={cn("flex min-w-0 items-stretch gap-0.5 bg-transparent", className)}
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
				"after:bg-transparent data-[state=active]:after:bg-primary",
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

/**
 * A count beside a tab label.
 *
 * A superscript rather than the `h-5` `Badge` pill this replaces: the pill set
 * a 20px floor that no 24px band can accommodate, and it was the single reason
 * the old triggers had to stay 38px tall. This sets no height at all.
 *
 * 10px is the documented micro step - see type-scale.test.ts, which rejects the
 * half-pixel sizes that come from nudging a number until it looks right.
 */
/**
 * The small superscript count on a tab.
 *
 * **Zero renders nothing.** A count is there to say "there are this many"; a
 * `0` says "there are none", which the tab's own empty state already says at
 * more length and without asking you to read a superscript to find out there is
 * nothing to read. The Console tab showed one the moment its gating was removed
 * and it always rendered - a `0` beside a tab whose panel says "No console
 * output".
 *
 * Handled here rather than at each call site because the call sites were
 * already working around it by hand: `RequestTabs` passes `badge: undefined`
 * and guards with `tab.badge !== undefined`, which is the same remembering
 * problem one level up. A caller that genuinely wants to show a zero can pass
 * the string `"0"`.
 */
function TabCount({ value, className }: { value: React.ReactNode; className?: string }) {
	if (value === 0) return null;

	return (
		<sup
			className={cn(
				"font-mono text-[10px] leading-none tabular-nums text-primary-text",
				className
			)}
		>
			{value}
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
			role="img"
			aria-label={label}
			title={label}
			className={cn("size-[5px] shrink-0 rounded-full bg-status-error", className)}
		/>
	);
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabLabel, TabCount, TabErrorDot };
