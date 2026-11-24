/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Truncated text that scrolls itself into view on hover or keyboard focus, so a long tab title
 * reads without opening it. It scrolls by the measured overflow at a constant speed, so a slightly
 * long label takes a moment and a very long one proportionally longer; text that fits gets no
 * animation, so short tabs stay still. CSS animation, so the app's reduced-motion rule
 * (animation-duration 0.01ms) disables it; callers still pass a `title`, keeping the text reachable
 * when nothing animates.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Pixels per second. Slow enough to read, quick enough not to feel stuck. */
const SPEED = 45;
/** Pauses at each end, in seconds - the keyframes hold at 0% and mid-cycle. */
const DWELL = 1.6;

interface ScrollOnOverflowProps {
	children: React.ReactNode;
	className?: string;
}

export function ScrollOnOverflow({ children, className }: ScrollOnOverflowProps) {
	const viewportRef = useRef<HTMLSpanElement>(null);
	const trackRef = useRef<HTMLSpanElement>(null);
	const [distance, setDistance] = useState(0);

	const measure = useCallback(() => {
		const viewport = viewportRef.current;
		const track = trackRef.current;
		if (!viewport || !track) return;
		// Sub-pixel differences are rounding, not real overflow.
		const overflow = track.scrollWidth - viewport.clientWidth;
		setDistance(overflow > 1 ? overflow : 0);
	}, []);

	// Re-measure when the box or text changes: a tab renaming or the drawer resizing both change
	// whether the label fits.
	useEffect(() => {
		measure();
		const viewport = viewportRef.current;
		if (!viewport || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(viewport);
		if (trackRef.current) ro.observe(trackRef.current);
		return () => ro.disconnect();
	}, [measure, children]);

	const overflowing = distance > 0;

	return (
		<span
			ref={viewportRef}
			className={cn("block overflow-hidden", overflowing && "scroll-on-overflow", className)}
		>
			<span
				ref={trackRef}
				className="block w-fit max-w-none whitespace-nowrap"
				style={
					overflowing
						? ({
								"--scroll-distance": `-${distance}px`,
								"--scroll-duration": `${(distance / SPEED) * 2 + DWELL * 2}s`,
							} as React.CSSProperties)
						: undefined
				}
			>
				{children}
			</span>
		</span>
	);
}
