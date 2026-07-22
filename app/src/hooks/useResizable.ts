/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

interface UseResizableOptions {
	defaultSize: number;
	min: number;
	max: number;
	/** "horizontal" (default) resizes width; "vertical" resizes height */
	direction?: "horizontal" | "vertical";
}

interface UseResizableReturn {
	size: number;
	isResizing: boolean;
	/** Wire to the drag handle's onMouseDown. Captures the drag origin so size
	 *  is computed as a delta - works for panels that don't start at x=0. */
	startResizing: (e: React.MouseEvent) => void;
	/**
	 * Nudge the size by a delta, clamped to the same bounds as a drag.
	 *
	 * A drag handle that only listens for the mouse is unusable from the
	 * keyboard, and this is a developer tool. Callers wire this to arrow keys on
	 * a focusable `role="separator"`.
	 *
	 * `Infinity` / `-Infinity` are accepted and clamp to max / min, so Home and
	 * End need no special case.
	 */
	resizeBy: (delta: number) => void;
	/** Current bounds, for the handle's `aria-valuemin` / `aria-valuemax`. */
	min: number;
	max: number;
}

/**
 * Manages drag-to-resize behavior for a panel along one axis.
 *
 * Uses delta-based calculation: new size = size at drag start + mouse delta.
 * This means the hook is correct regardless of where the panel sits in the
 * layout, unlike an approach that sets size = raw clientX.
 */
export function useResizable({
	defaultSize,
	min,
	max,
	direction = "horizontal",
}: UseResizableOptions): UseResizableReturn {
	const [rawSize, setRawSize] = useState(defaultSize);
	const [isResizing, setIsResizing] = useState(false);
	const dragStart = useRef<{ mousePos: number; size: number } | null>(null);

	// Clamp during render so size never violates the active bounds (e.g. a
	// per-context min that rises when the active tab demands more room). Derived
	// rather than synced via an effect to avoid a cascading re-render.
	const size = useMemo(() => Math.min(max, Math.max(min, rawSize)), [min, max, rawSize]);

	const startResizing = useCallback(
		(e: React.MouseEvent) => {
			dragStart.current = {
				mousePos: direction === "horizontal" ? e.clientX : e.clientY,
				size,
			};
			setIsResizing(true);
		},
		[direction, size]
	);

	useEffect(() => {
		if (!isResizing) return;

		const handleMouseMove = (e: MouseEvent) => {
			if (!dragStart.current) return;
			const current = direction === "horizontal" ? e.clientX : e.clientY;
			const next = Math.min(
				max,
				Math.max(min, dragStart.current.size + (current - dragStart.current.mousePos))
			);
			setRawSize(next);
		};

		const handleMouseUp = () => {
			dragStart.current = null;
			setIsResizing(false);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
		document.body.style.userSelect = "none";

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
	}, [isResizing, min, max, direction]);

	// Nudged from the *derived* size, not the raw one: if bounds tightened since
	// the last drag, a nudge should move from where the panel actually is. That
	// part is load-bearing and tested.
	//
	// The clamp on the way in is not - `size` re-clamps on every render, so
	// removing it changes no observable behaviour (a mutation test confirmed the
	// suite cannot tell). It stays so the stored value never goes out of range,
	// which matters because callers pass ±Infinity for jump-to-extreme and
	// `Infinity` is not something to keep in state.
	const resizeBy = useCallback(
		(delta: number) => setRawSize(Math.min(max, Math.max(min, size + delta))),
		[min, max, size]
	);

	return { size, isResizing, startResizing, resizeBy, min, max };
}
