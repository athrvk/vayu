/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag handle for the drawer, the context bar and the bottom panel: one component, so the
 * copies cannot drift, and a window splitter, so the panels framing the app resize and reset from
 * the keyboard, where this tool's users work. Arrows nudge, Page keys jump, Home and End go to the
 * bounds, and Enter or Space resets to the default, as double-click does.
 *
 * `side` sets direction, not just placement, which is the reason for sharing: the drawer's handle
 * is on its right edge, so ArrowRight widens it; the context bar's is on its left, so ArrowLeft
 * widens. `side: "top"` is the bottom panel's: a horizontal separator moved on the vertical axis,
 * where pointer up grows the panel and so do ArrowUp and PageUp. The measure there is height, hence
 * `size`, not `width`. `side` governs the *spatial* keys only: Home and End name a point in the
 * value model the handle announces, the same bound from either side.
 *
 * The drag and key-repeat mechanics are `useResizeGesture`'s (#1715, shared with
 * `ScriptElementForm`'s vertical drag in #1738): a drag paints the panel's `style.width`
 * (`style.height` for a top handle) through the handle's `parentElement`, since every panel renders
 * this handle as the direct child of the element it sizes, once per frame, and writes the store
 * once, on release. The double-click reset and a single key press write at once; only a held key's
 * repeat coalesces, like the drag's paint.
 */

import { useRef } from "react";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "@/constants/layout";
import { cn } from "@/lib/utils";
import { useResizeGesture } from "@/lib/resize-gesture";

/** One arrow press. Enough to see, small enough to aim with. */
const STEP = 16;
/** Page keys, for crossing the range without holding a key down. */
const PAGE_STEP = 64;

export interface PanelResizeHandleProps {
	/** Which edge of its panel the handle sits on. Sets the axis and the drag/key direction. */
	side: "left" | "right" | "top";
	/** The panel's extent along the drag axis: its width, or its height for `side: "top"`. */
	size: number;
	setSize: (size: number) => void;
	/** Reset target, for double-click and for Enter/Space. */
	defaultSize: number;
	/** Named so the handles are distinguishable when focused. */
	label: string;
	/** Bounds of `size`. The side panels' width bounds unless the caller has its own. */
	min?: number;
	max?: number;
}

/**
 * Each key's edge move, in the direction it points: positive is right or down. Page keys follow
 * their arrow axis, so on y PageUp moves the edge up.
 */
const SPATIAL_STEPS = {
	x: new Map([
		["ArrowLeft", -STEP],
		["ArrowRight", STEP],
		["PageUp", PAGE_STEP],
		["PageDown", -PAGE_STEP],
	]),
	y: new Map([
		["ArrowUp", -STEP],
		["ArrowDown", STEP],
		["PageUp", -PAGE_STEP],
		["PageDown", PAGE_STEP],
	]),
} as const;

/** The grab strip on each edge: 8px across, the full length of the edge. */
const HANDLE_STRIP: Record<PanelResizeHandleProps["side"], string> = {
	right: "top-0 bottom-0 right-0 w-2 cursor-col-resize",
	left: "top-0 bottom-0 left-0 w-2 cursor-col-resize z-10",
	top: "left-0 right-0 top-0 h-2 cursor-row-resize z-10",
};

/** The 1px rule the strip draws, on the strip's own edge. */
const HANDLE_RULE: Record<PanelResizeHandleProps["side"], string> = {
	right: "top-0 bottom-0 right-0 w-px",
	left: "top-0 bottom-0 left-0 w-px",
	top: "left-0 right-0 top-0 h-px",
};

export function PanelResizeHandle({
	side,
	size,
	setSize,
	defaultSize,
	label,
	min = PANEL_MIN_WIDTH,
	max = PANEL_MAX_WIDTH,
}: PanelResizeHandleProps) {
	const axis = side === "top" ? "y" : "x";
	// A left or top handle grows its panel as the pointer moves away from the body (left, up), so
	// its delta is inverted from a right-edge handle's.
	const grow = side === "right" ? 1 : -1;

	const handleRef = useRef<HTMLDivElement | null>(null);
	const gesture = useResizeGesture({
		min,
		max,
		getValue: () => size,
		commit: setSize,
		paint: (value) => {
			const panel = handleRef.current?.parentElement;
			if (!panel) return;
			if (axis === "y") panel.style.height = `${value}px`;
			else panel.style.width = `${value}px`;
		},
	});

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		// Arrows and Page keys are spatial: the edge travels the way they point, so they follow
		// `grow`.
		const nudge = (delta: number) => {
			e.preventDefault();
			gesture.applyKey(e, gesture.currentValue() + delta * grow);
		};

		// Home and End are absolute against the value model this handle declares
		// (`aria-valuemin`/`max`), so they must NOT follow `grow`: on the context bar's left-side
		// handle that inverts them, and a screen reader hearing "min 220, max 480" would announce
		// Home as the minimum while it jumps to 480.
		const jumpTo = (target: number) => {
			e.preventDefault();
			gesture.applyKey(e, target);
		};

		const step = SPATIAL_STEPS[axis].get(e.key);
		if (step !== undefined) return nudge(step);

		switch (e.key) {
			case "Home":
				return jumpTo(min);
			case "End":
				return jumpTo(max);
			case "Enter":
			case " ":
				// The keyboard equivalent of the double-click reset, otherwise the one affordance
				// with no non-mouse route.
				e.preventDefault();
				gesture.applyKey(e, defaultSize);
				return;
			default:
				return;
		}
	};

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA window splitter - a focusable `role="separator"` is its sanctioned interactive form, with the arrow/Page/Home/End handling in the onKeyDown just below
		<div
			ref={handleRef}
			role="separator"
			// A separator's orientation is its line's, not the drag's: the side handles are
			// vertical lines dragged along x, the top one a horizontal line dragged along y.
			aria-orientation={axis === "y" ? "horizontal" : "vertical"}
			aria-label={label}
			aria-valuenow={Math.round(size)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			onPointerDown={(e) => gesture.startDrag(e, axis, grow)}
			onDoubleClick={() => setSize(defaultSize)}
			onKeyDown={onKeyDown}
			onKeyUp={gesture.flushKey}
			onBlur={gesture.flushKey}
			className={cn(
				"absolute transition-colors hover:bg-accent/20",
				// An 8px strip with no content: the focus state is all that makes it findable by
				// keyboard.
				"focus-visible:bg-accent/40",
				HANDLE_STRIP[side]
			)}
		>
			<div className={cn("absolute bg-border", HANDLE_RULE[side])} />
		</div>
	);
}
