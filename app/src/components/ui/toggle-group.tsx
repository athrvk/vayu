/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A segmented control: one choice of a few, all visible, on Radix's ToggleGroup for arrow keys and
 * roving focus. As in `Tabs`, every state change is a `data-[state=]` variant, so only the
 * attribute moves. **A static class list is not enough**: `data-[state=on]:font-semibold` makes an
 * active segment's text wider and shoves the others; `ToggleGroupItem` reserves the bold width as
 * `tabs.tsx` does (`TabLabel`), rendering its children twice in one grid cell with a hidden
 * `font-semibold` copy sizing the column. **Sizes are the app's floor steps** (#1679): `xs` is
 * `--spacing-control-sm` (24px), `sm` `--spacing-control` (28px); the response toolbar sits an `xs`
 * control on a 32px `band`, a step above the tab strip. Named steps off `--spacing` (a 3px rhythm,
 * #1670, where `h-5`/`h-6` are 15px/18px) keep 24px and 28px.
 */

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

import { cn } from "@/lib/utils";

/** Track height. `xs` is 24px, `sm` is 28px - the same steps `tabs.tsx` uses. */
type SegmentSize = "xs" | "sm";

const TRACK: Record<SegmentSize, string> = {
	xs: "p-0.5",
	sm: "p-1",
};

const ITEM: Record<SegmentSize, string> = {
	xs: "h-control-sm px-2 text-label",
	sm: "h-control px-2.5 text-xs",
};

// The gap is on the inner content spans, not the item (see `ToggleGroupItem`'s width reservation).
const ITEM_GAP: Record<SegmentSize, string> = {
	xs: "gap-1",
	sm: "gap-1.5",
};

const SegmentSizeContext = React.createContext<SegmentSize>("xs");

/*
 * Radix's Root props are a union on `type`, so omitting `type` leaves `value` as
 * `string | string[]` and every caller casts; extracting the single-select arm makes
 * `value: string`.
 */
type SingleRootProps = Extract<
	React.ComponentProps<typeof ToggleGroupPrimitive.Root>,
	{ type: "single" }
>;

export interface ToggleGroupProps extends Omit<SingleRootProps, "type"> {
	size?: SegmentSize;
}

/**
 * Single-select only: multi-select is another control, nothing wants one, and offering `type`
 * invites a checkbox row looking like a segmented control.
 */
function ToggleGroup({ className, size = "xs", ...props }: ToggleGroupProps) {
	return (
		<SegmentSizeContext.Provider value={size}>
			<ToggleGroupPrimitive.Root
				type="single"
				data-slot="toggle-group"
				className={cn(
					/*
					 * No track fill and no outline: the raised active segment is the affordance. A
					 * filled track reads as a bordered widget dropped onto the toolbar, and its
					 * fill would be `--muted`, the toolbar's own colour. `rounded-md` stays, so the
					 * padding box follows Roundedness for the segment corners inside.
					 */
					"inline-flex items-center rounded-md",
					TRACK[size],
					className
				)}
				{...props}
			/>
		</SegmentSizeContext.Provider>
	);
}

function ToggleGroupItem({
	className,
	size,
	children,
	...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { size?: SegmentSize }) {
	const inherited = React.useContext(SegmentSizeContext);
	const itemSize = size ?? inherited;
	return (
		<ToggleGroupPrimitive.Item
			data-slot="toggle-group-item"
			className={cn(
				"inline-flex shrink-0 items-center justify-center whitespace-nowrap",
				// A step tighter than the track, so the inner corner follows the outer at high
				// Roundedness.
				"rounded-[calc(var(--radius)-2px)]",
				"font-medium text-muted-foreground transition-colors",
				"hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				/*
				 * The active chip is the *tinted* one; the row stays its surface's colour.
				 * Measured:
				 *
				 *                          light    dark
				 *     card vs muted        1.18     1.15
				 *     primary/10 on muted  1.25     1.05
				 *     primary/15 on muted  1.41     1.07
				 *
				 * An accent tint, the obvious "active" fill, is *worse* in dark: at 10-15% alpha it
				 * barely moves luminance. No fill carries this alone at ~1.16, and none needs to:
				 * the text does, `--foreground` against `--muted-foreground` at 13.69 dark, a
				 * *non-chromatic* difference that survives graphite's neutral accent (the trap
				 * `tabs.tsx` documents). Not accent-coloured: the tab strip above uses accent text
				 * and an underline, and repeating it would read as a second tab row.
				 */
				"data-[state=on]:bg-accent data-[state=on]:text-foreground",
				"data-[state=on]:font-semibold data-[state=on]:shadow-sm",
				ITEM[itemSize],
				className
			)}
			{...props}
		>
			{/*
			 * Width reservation (see the file header): the children render twice in one grid cell,
			 * so the column is always the bold form's width. `font-weight` inherits, so the visible
			 * copy takes the item's current weight with no class of its own.
			 */}
			<span className="grid">
				<span
					data-slot="toggle-group-item-reserve"
					aria-hidden="true"
					className={cn(
						"invisible col-start-1 row-start-1 flex h-0 items-center font-semibold",
						ITEM_GAP[itemSize]
					)}
				>
					{children}
				</span>
				<span
					className={cn("col-start-1 row-start-1 flex items-center", ITEM_GAP[itemSize])}
				>
					{children}
				</span>
			</span>
		</ToggleGroupPrimitive.Item>
	);
}

export { ToggleGroup, ToggleGroupItem };
