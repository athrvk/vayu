/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A segmented control: one choice out of a few, all of them visible.
 *
 * The response body's Pretty / Raw / Preview switch was a hand-rolled version -
 * three `<Button variant="ghost">` inside a `bg-muted` div, each repeating the
 * same eight-class active/inactive string. It carried four defects that a
 * primitive would never have had:
 *
 *   - **No radius class on the track**, so it stayed square at every Roundedness
 *     setting while its neighbours followed it.
 *   - **`gap-1` between segments**, which reads as loose chips on a strip rather
 *     than one control.
 *   - **The active state written out per segment**, three copies of one rule.
 *   - **A `bg-muted` track on a `bg-muted/20` row** - same hue, 20% apart, so
 *     the track barely existed. There is no track fill at all now: the raised
 *     active segment is the affordance, which sidesteps the problem rather than
 *     restating it.
 *
 * Built on Radix's ToggleGroup, so arrow-key movement and roving focus arrive
 * with it. Like `Tabs`, every state change is a `data-[state=]` variant rather
 * than a swapped class: the class list is identical either way and only the
 * attribute moves.
 *
 * **The class list being static is not enough on its own.** `data-[state=on]:
 * font-semibold` still changes the rendered *weight* of an active segment's
 * text, and a heavier weight is wider - so without help, activating a segment
 * shoves every segment (and anything sitting beside the group) sideways.
 * `tabs.tsx` hit this exact bug (`TabLabel`'s doc comment names it) and fixed
 * it by reserving the bold width up front, in the primitive, rather than at
 * each call site; `ToggleGroupItem` does the same thing here: its children
 * render twice, stacked in one grid cell, with a `font-semibold` hidden copy
 * sizing the column so the visible copy's own weight never changes the box.
 *
 * **Sizes are the app's band steps**, not new numbers. `xs` is 24px and `sm` is
 * 28px, matching `tabs.tsx` - the response toolbar sits an `xs` control on a
 * 32px band, one step above the 24px tab strip above it.
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
	xs: "h-5 px-2 text-[11px]",
	sm: "h-6 px-2.5 text-xs",
};

// The gap sits on the inner content spans, not the item itself - see
// `ToggleGroupItem`'s width-reservation comment below.
const ITEM_GAP: Record<SegmentSize, string> = {
	xs: "gap-1",
	sm: "gap-1.5",
};

const SegmentSizeContext = React.createContext<SegmentSize>("xs");

/*
 * Radix's Root props are a union discriminated on `type`, so simply omitting
 * `type` leaves `value` as `string | string[]` and every caller has to cast.
 * Extracting the single-select arm first is what makes `value: string`.
 */
type SingleRootProps = Extract<
	React.ComponentProps<typeof ToggleGroupPrimitive.Root>,
	{ type: "single" }
>;

export interface ToggleGroupProps extends Omit<SingleRootProps, "type"> {
	size?: SegmentSize;
}

/**
 * Single-select only. A multi-select toggle group is a different control with
 * different semantics, and nothing here wants one - offering `type` would invite
 * a caller to build a checkbox row that looks like a segmented control.
 */
function ToggleGroup({ className, size = "xs", ...props }: ToggleGroupProps) {
	return (
		<SegmentSizeContext.Provider value={size}>
			<ToggleGroupPrimitive.Root
				type="single"
				data-slot="toggle-group"
				className={cn(
					/*
					 * No track fill and no outline. The raised active segment is the
					 * whole affordance.
					 *
					 * A filled track was tried and is wrong here twice over. It draws a
					 * box around the segments that reads as a bordered widget dropped
					 * onto the toolbar rather than part of it - and the fill would have
					 * to be `--muted`, which is exactly what the toolbar it sits on
					 * already is. That is the same-colour-on-same-colour defect the old
					 * hand-rolled version had (`bg-muted` on `bg-muted/20`), arrived at
					 * from the other direction.
					 *
					 * `rounded-md` stays, so the padding box still follows the
					 * Roundedness setting for the segment corners inside it.
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
				// One step tighter than the track, so the inner corner follows the
				// outer one instead of sitting proud of it at high Roundedness.
				"rounded-[calc(var(--radius)-2px)]",
				"font-medium text-muted-foreground transition-colors",
				"hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				/*
				 * The active chip is the *tinted* one, and the row around it stays
				 * the surface it belongs to.
				 *
				 * This was `bg-card` first, which assumed a `--muted` toolbar to lift
				 * off. That toolbar turned out to be the wrong idea - a full muted
				 * fill made the row a grey band between a card-coloured tab strip and
				 * a card-coloured editor - so the row is card now and the chip is
				 * muted. The measured separation is the same either way, because it
				 * is the same pair of colours:
				 *
				 *                          light    dark
				 *     card vs muted        1.18     1.15
				 *     primary/10 on muted  1.25     1.05
				 *     primary/15 on muted  1.41     1.07
				 *
				 * An accent tint looks like the obvious "active" fill and is the
				 * *worse* option in dark - at 10-15% alpha it barely moves luminance.
				 *
				 * No fill carries this alone at ~1.16, and none needs to. The text
				 * does the work: `--foreground` against `--muted-foreground` measures
				 * 13.69 dark. That difference is *non-chromatic*, which matters
				 * because the graphite scheme's accent is a neutral - a hue-based
				 * active state vanishes there, the trap `tabs.tsx` documents.
				 *
				 * Deliberately not accent-coloured. The tab strip directly above uses
				 * accent text plus an underline; repeating that here would make the
				 * toolbar read as a second tab row.
				 */
				"data-[state=on]:bg-accent data-[state=on]:text-foreground",
				"data-[state=on]:font-semibold data-[state=on]:shadow-sm",
				ITEM[itemSize],
				className
			)}
			{...props}
		>
			{/*
			 * Width reservation (see the file-level comment): the children render
			 * twice, stacked in one grid cell, so the column is always as wide as
			 * the bold form - the visible copy's own weight (medium at rest, the
			 * `data-[state=on]` semibold above once active) never changes the box.
			 * `font-weight` is inherited, so the visible copy needs no weight class
			 * of its own; it just takes whatever this item currently has.
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
