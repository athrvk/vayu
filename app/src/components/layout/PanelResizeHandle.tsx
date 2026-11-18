/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag handle for the drawer, the context bar and the bottom panel.
 *
 * Both panels had their own copy - the context bar's carried a comment saying
 * it "mirrors the Drawer's right-edge handle", which is the usual sign that one
 * of them will drift. Both were also mouse-only: a bare `<div>` with
 * `onPointerDown` and `onDoubleClick`, no role, no tabindex, no keys. So the two
 * panels framing the entire app could not be resized or reset from the
 * keyboard, on a tool whose users work from the keyboard.
 *
 * It is a window splitter now: focusable, arrows nudge, Page keys jump, Home and
 * End go to the bounds, and Enter or Space resets to the default - the keyboard
 * equivalent of the double-click that was already there.
 *
 * `side` matters for direction, not just placement. The drawer's handle sits on
 * its right edge, so ArrowRight widens it; the context bar's sits on its left,
 * so ArrowLeft widens. Getting this from the prop rather than a second component
 * is the whole reason for sharing.
 *
 * `side: "top"` is the bottom panel's: a handle on the panel's top edge, drawn
 * as a horizontal separator, dragged and nudged on the vertical axis. Pointer up
 * grows the panel, so ArrowUp and PageUp do too - the keys follow the edge, as
 * the horizontal pair does. The measure it resizes is the panel's height there,
 * which is why the props say `size` and not `width`.
 *
 * It governs the *spatial* keys only. Home and End name a point in the value
 * model the handle announces, so they land on the same bound from either side.
 *
 * The drag and keyboard-repeat mechanics are `useResizeGesture`'s (issue
 * #1715, generalized in #1738 rather than left as this component's own copy
 * once `ScriptElementForm` needed the identical shape for a vertical drag):
 * a pointer drag paints the panel's `style.width` (`style.height` for a top
 * handle) - through the handle's own `parentElement`, since every panel renders
 * this handle as the direct child of the element whose size it controls - once
 * per animation frame and writes the store exactly once, on release. The
 * double-click reset and a single keyboard press still write immediately;
 * only a held key's repeat coalesces, the same way the drag's paint does.
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
 * What each key moves the edge by, in the direction the key points: a positive
 * step is right or down. Page keys follow their arrow axis, so on the vertical
 * axis PageUp moves the edge up.
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
	// A handle on the left or top edge grows its panel as the pointer moves
	// away from the panel's body (left, up), so the delta is inverted relative
	// to one on the right edge.
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
		// Arrows and Page keys are spatial: the direction they move the pointer is
		// the direction the edge travels, so they follow `grow`.
		const nudge = (delta: number) => {
			e.preventDefault();
			gesture.applyKey(e, gesture.currentValue() + delta * grow);
		};

		// Home and End are absolute against the value model this handle declares
		// (`aria-valuemin`/`max`), so they must NOT follow `grow` - on the context
		// bar's left-side handle that inverted them, and a screen reader hearing
		// "min 220, max 480" announced Home as the minimum while it jumped to 480.
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
				// The keyboard equivalent of the double-click reset, which was
				// otherwise the one affordance with no non-mouse route to it.
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
			// A separator's orientation is the line's own, not the drag's: the side
			// handles are vertical lines dragged along x, the top one a horizontal
			// line dragged along y.
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
				// The handle is a 8px strip with no content, so the focus state is
				// the only thing that makes it findable by keyboard.
				"focus-visible:bg-accent/40",
				HANDLE_STRIP[side]
			)}
		>
			<div className={cn("absolute bg-border", HANDLE_RULE[side])} />
		</div>
	);
}
