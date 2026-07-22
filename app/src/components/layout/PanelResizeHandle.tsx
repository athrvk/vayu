/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag handle for the drawer and the context bar.
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
 */

import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "@/constants/layout";
import { cn } from "@/lib/utils";

/** One arrow press. Enough to see, small enough to aim with. */
const STEP = 16;
/** Page keys, for crossing the range without holding a key down. */
const PAGE_STEP = 64;

export interface PanelResizeHandleProps {
	/** Which edge of its panel the handle sits on. Sets the drag/key direction. */
	side: "left" | "right";
	width: number;
	setWidth: (width: number) => void;
	/** Reset target, for double-click and for Enter/Space. */
	defaultWidth: number;
	/** Named so the two handles are distinguishable when focused. */
	label: string;
}

export function PanelResizeHandle({
	side,
	width,
	setWidth,
	defaultWidth,
	label,
}: PanelResizeHandleProps) {
	// A handle on the left edge grows its panel as the pointer moves left, so the
	// delta is inverted relative to one on the right edge.
	const grow = side === "right" ? 1 : -1;

	const startResize = (e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startWidth = width;

		const onMove = (moveEvent: PointerEvent) => {
			setWidth(startWidth + (moveEvent.clientX - startX) * grow);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		const nudge = (delta: number) => {
			e.preventDefault();
			// The store clamps to PANEL_MIN_WIDTH / PANEL_MAX_WIDTH, so ±Infinity
			// from Home and End needs no special case here.
			setWidth(width + delta * grow);
		};

		switch (e.key) {
			case "ArrowLeft":
				return nudge(-STEP);
			case "ArrowRight":
				return nudge(STEP);
			case "PageUp":
				return nudge(PAGE_STEP);
			case "PageDown":
				return nudge(-PAGE_STEP);
			case "Home":
				return nudge(-Infinity);
			case "End":
				return nudge(Infinity);
			case "Enter":
			case " ":
				// The keyboard equivalent of the double-click reset, which was
				// otherwise the one affordance with no non-mouse route to it.
				e.preventDefault();
				setWidth(defaultWidth);
				return;
			default:
				return;
		}
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width)}
			aria-valuemin={PANEL_MIN_WIDTH}
			aria-valuemax={PANEL_MAX_WIDTH}
			tabIndex={0}
			onPointerDown={startResize}
			onDoubleClick={() => setWidth(defaultWidth)}
			onKeyDown={onKeyDown}
			className={cn(
				"absolute top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/20",
				// The handle is a 8px strip with no content, so the focus state is
				// the only thing that makes it findable by keyboard.
				"focus-visible:bg-accent/40",
				side === "right" ? "right-0" : "left-0 z-10"
			)}
		>
			<div
				className={cn(
					"absolute top-0 bottom-0 w-px bg-border",
					side === "right" ? "right-0" : "left-0"
				)}
			/>
		</div>
	);
}
