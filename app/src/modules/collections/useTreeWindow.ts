/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Mount the collection tree's rows in view, and stand in for the rest (#2543).
 *
 * The tree's rows are fixed-height by construction - each row's wrapper is
 * given its height in spacing units (`rowHeightUnits`) - so where any row sits
 * is a prefix sum the tree can compute without mounting it. That is what makes
 * a window cheap here, where `useGrowingWindow` records why one is not for
 * lists whose rows wrap: there is no row to measure and no scroll map to keep.
 * The skipped runs are spacers of the same units, so the scrollbar is the whole
 * list's.
 *
 * The scroller is the drawer body (`DrawerPanel`'s `[data-drawer-body]`), which
 * the tree shares with the toolbar's new-collection form; the viewport is read
 * relative to the list's own top, so whatever sits above it is subtracted.
 *
 * **Everything mounts where nothing can be measured**: no scroller, no
 * `ResizeObserver`, or a scroller with no height. jsdom is all three, so a test
 * that does not stub them renders the whole tree, as the tree always did.
 */

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { scrollWithin } from "@/lib/scroll-within";
import {
	mountedSegments,
	nearestScrollTop,
	rowOffsets,
	visibleRange,
	type RowRange,
	type RowSegment,
} from "./tree-window";

/** The drawer body every drawer view scrolls in. */
const SCROLLER = "[data-drawer-body]";

/**
 * Below this many rows the whole list mounts, and it is also how many mount
 * before the first measurement (a commit that never paints: the measurement
 * is a layout effect).
 */
const MIN_WINDOWED_ROWS = 100;

/** Rows mounted past each edge of the viewport, so a scroll frame never shows a gap. */
const OVERSCAN_ROWS = 10;

/**
 * The viewport is read in steps of this many units (four rows), so scrolling
 * re-renders the list once per step rather than once per frame. The overscan
 * is wider than a step, so the rows in view are always mounted.
 */
const VIEWPORT_STEP_UNITS = 32;

/** Tailwind's own `--spacing` default, for a token that does not resolve. */
const FALLBACK_SPACING_PX = 4;

/** The part of the list in view, in units from its top edge, stepped. */
interface Viewport {
	top: number;
	height: number;
}

type Measured = Viewport | "unbounded";

export interface TreeWindow {
	/** What to render, in order: runs of mounted rows and the gaps between them. */
	segments: RowSegment[];
	/**
	 * Scroll the drawer so `rows[index]` is in view. `mounted` is its element
	 * when it has one, which is all an unwindowed list scrolls by.
	 */
	scrollToRow: (index: number, mounted: Element | null) => void;
}

/** `--spacing` in pixels. The token is a rem length; a px one is read as is. */
function readSpacingPx(element: Element): number {
	const raw = getComputedStyle(element).getPropertyValue("--spacing").trim();
	const value = parseFloat(raw);
	if (!(value > 0)) return FALLBACK_SPACING_PX;
	if (raw.endsWith("px")) return value;
	if (!raw.endsWith("rem")) return FALLBACK_SPACING_PX;
	return value * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
}

function steppedViewport(topPx: number, heightPx: number, spacingPx: number): Viewport {
	const top = Math.floor(topPx / spacingPx / VIEWPORT_STEP_UNITS) * VIEWPORT_STEP_UNITS;
	const bottom = (topPx + heightPx) / spacingPx;
	return { top, height: Math.ceil((bottom - top) / VIEWPORT_STEP_UNITS) * VIEWPORT_STEP_UNITS };
}

/** Where the list's top edge sits in the scroller's scrolled content, in px. */
function listTopIn(scroller: HTMLElement, list: HTMLElement): number {
	return (
		list.getBoundingClientRect().top -
		scroller.getBoundingClientRect().top -
		scroller.clientTop +
		scroller.scrollTop
	);
}

function sameViewport(a: Measured | null, b: Measured): boolean {
	if (a === b) return true;
	if (a === null || a === "unbounded" || b === "unbounded") return false;
	return a.top === b.top && a.height === b.height;
}

/**
 * @param list the element the rows render into. `null` until it mounts, and
 *   then the first `MIN_WINDOWED_ROWS` rows mount.
 * @param strides each row's pitch in spacing units (`rowStrides`).
 * @param pinned rows that stay mounted wherever the viewport is.
 */
export function useTreeWindow(
	list: HTMLElement | null,
	strides: readonly number[],
	pinned: readonly number[]
): TreeWindow {
	const [measured, setMeasured] = useState<Measured | null>(null);
	const offsets = useMemo(() => rowOffsets(strides), [strides]);
	const count = strides.length;

	useLayoutEffect(() => {
		if (!list) return;
		const scroller = list.closest<HTMLElement>(SCROLLER);
		const observable = scroller !== null && typeof ResizeObserver !== "undefined";

		// Read once, then again only on a resize: a density change rescales every
		// row, which resizes the list.
		let spacingPx = readSpacingPx(list);
		let frame: number | null = null;
		const measure = () => {
			frame = null;
			const next: Measured =
				observable && scroller.clientHeight > 0
					? steppedViewport(
							scroller.scrollTop - listTopIn(scroller, list),
							scroller.clientHeight,
							spacingPx
						)
					: "unbounded";
			setMeasured((current) => (sameViewport(current, next) ? current : next));
		};
		measure();
		if (!observable) return;

		const schedule = () => {
			if (frame === null) frame = requestAnimationFrame(measure);
		};
		const onResize = () => {
			spacingPx = readSpacingPx(list);
			schedule();
		};
		scroller.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(onResize);
		observer.observe(scroller);
		observer.observe(list);
		return () => {
			scroller.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [list]);

	const viewport = count >= MIN_WINDOWED_ROWS && measured !== "unbounded" ? measured : undefined;
	let range: RowRange = { start: 0, end: count };
	if (viewport === null) range = { start: 0, end: MIN_WINDOWED_ROWS };
	else if (viewport) {
		range = visibleRange(offsets, viewport.top, viewport.height, OVERSCAN_ROWS);
	}
	const { start, end } = range;
	const segments = useMemo(
		() => mountedSegments(count, { start, end }, pinned),
		[count, start, end, pinned]
	);

	const scrollToRow = useCallback(
		(index: number, mounted: Element | null) => {
			const scroller = list?.closest<HTMLElement>(SCROLLER);
			if (!list || !scroller) return;
			// Read from the DOM rather than from `measured`: a reveal can run in
			// the commit that first brings the list in, before any measurement.
			const windowed =
				count >= MIN_WINDOWED_ROWS &&
				typeof ResizeObserver !== "undefined" &&
				scroller.clientHeight > 0;
			if (!windowed) {
				if (mounted) scrollWithin(scroller, mounted, { block: "nearest" });
				return;
			}
			const spacingPx = readSpacingPx(list);
			const listTop = listTopIn(scroller, list);
			const top = nearestScrollTop(
				scroller.scrollTop,
				scroller.clientHeight,
				listTop + offsets[index] * spacingPx,
				listTop + offsets[index + 1] * spacingPx
			);
			if (top === scroller.scrollTop) return;
			scroller.scrollTo({ top });
			// Not left to the scroll event: the caller is about to act on the row,
			// and the window has to be where it is going before the next render.
			setMeasured(steppedViewport(top - listTop, scroller.clientHeight, spacingPx));
		},
		[count, list, offsets]
	);

	return { segments, scrollToRow };
}
