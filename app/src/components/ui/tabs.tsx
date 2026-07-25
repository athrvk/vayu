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

const SIZE: Record<TabSize, string> = {
	xs: "px-2.5 py-1",
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
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm",
				"text-xs font-medium text-muted-foreground",
				"ring-offset-background transition-colors",
				"hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				// Both halves are `data-[state=]` variants rather than swapped
				// classes, so the class list is identical in either state and only
				// the attribute moves. Paired with TabLabel, activating a tab
				// changes nothing that affects layout.
				"data-[state=active]:text-primary-text data-[state=active]:font-semibold",
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
 */
function TabCount({ value, className }: { value: React.ReactNode; className?: string }) {
	return (
		<sup
			className={cn(
				"font-mono text-[9.5px] leading-none tabular-nums text-primary-text",
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
function TabErrorDot({ label = "Script error", className }: { label?: string; className?: string }) {
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
