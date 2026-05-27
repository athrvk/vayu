/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useEffect, useRef, useCallback } from "react";

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
	 *  is computed as a delta — works for panels that don't start at x=0. */
	startResizing: (e: React.MouseEvent) => void;
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
	const [size, setSize] = useState(defaultSize);
	const [isResizing, setIsResizing] = useState(false);
	const dragStart = useRef<{ mousePos: number; size: number } | null>(null);

	// Re-clamp size whenever the bounds change (e.g. a per-context min that
	// rises when the active tab demands more room). Without this, an
	// already-narrow size would silently violate the new floor.
	useEffect(() => {
		setSize((s) => Math.min(max, Math.max(min, s)));
	}, [min, max]);

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
			setSize(next);
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

	return { size, isResizing, startResizing };
}
