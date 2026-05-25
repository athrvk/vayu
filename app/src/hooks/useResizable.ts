
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useEffect, useCallback } from "react";

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
	startResizing: () => void;
}

/**
 * Manages drag-to-resize behavior for a panel along one axis.
 *
 * Returns `size` (px), `isResizing` flag, and `startResizing` to wire up
 * to the drag handle's onMouseDown. Cleans up global listeners automatically.
 */
export function useResizable({
	defaultSize,
	min,
	max,
	direction = "horizontal",
}: UseResizableOptions): UseResizableReturn {
	const [size, setSize] = useState(defaultSize);
	const [isResizing, setIsResizing] = useState(false);

	const startResizing = useCallback(() => {
		setIsResizing(true);
	}, []);

	useEffect(() => {
		if (!isResizing) return;

		const handleMouseMove = (e: MouseEvent) => {
			const next = direction === "horizontal" ? e.clientX : e.clientY;
			if (next >= min && next <= max) setSize(next);
		};

		const handleMouseUp = () => setIsResizing(false);

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
