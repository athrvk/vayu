/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs list's window (#3670): the rows mounted out of everything held, at
 * most `LOG_WINDOW_MAX_ROWS` of them whatever the store holds (up to 10,000).
 *
 * **Two ends, anchored on the reader's rows.** While following, the window is
 * the newest lines. Otherwise it starts at the line it starts at, held as the
 * entry itself, never as an index: the store drops the oldest lines, which
 * moves every index under the window. Lines appended below sit past the lower
 * end and mount only when the reader scrolls to them, so a tail batch or a page
 * newer costs nothing until it is read. A sentinel at each end grows the window
 * by a step towards it, and past the cap the far end gives the rows up.
 *
 * Growing a plain list rather than measuring rows is `useGrowingWindow`'s
 * argument (an opened row is a block of JSON): `content-visibility` on the rows
 * skips layout for those off screen. Rows mounted above the reader are held in
 * place by the caller (`useHoldPlace`, #3675), which the top sentinel's growth
 * asks for just before it happens: the browser does not anchor at `scrollTop` 0,
 * and without it the sentinel stays in view and the window stops at one step.
 * Only that growth moves the scroller; the follow pin, the bottom sentinel and
 * a new generation do not.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import type { LogEntry } from "@/types/electron";

/** The first window after the list is replaced, and how far a sentinel grows it. */
export const LOG_WINDOW_STEP = GROWING_WINDOW_STEP;
/** The most rows mounted at once. */
export const LOG_WINDOW_MAX_ROWS = 3 * LOG_WINDOW_STEP;

interface Anchor {
	generation: number;
	/** The first row of the window; undefined until there is one, which means the newest rows. */
	first: LogEntry | undefined;
	/** The rows the window spans from `first`, never more than `LOG_WINDOW_MAX_ROWS`. */
	count: number;
}

interface Bounds {
	start: number;
	end: number;
}

function initialAnchor(generation: number): Anchor {
	return { generation, first: undefined, count: LOG_WINDOW_STEP };
}

/**
 * Whether the store dropped @p entry off the newest end (Search older, at the
 * bound) rather than the oldest (following). `ts` is ISO UTC, so strings order;
 * a line without one is taken as dropped from the oldest.
 */
function droppedNewest(records: readonly LogEntry[], entry: LogEntry): boolean {
	const newest = records[records.length - 1];
	return !!newest && "ts" in entry && "ts" in newest && entry.ts > newest.ts;
}

function boundsOf(records: readonly LogEntry[], anchor: Anchor, follow: boolean): Bounds {
	const length = records.length;
	if (follow || anchor.first === undefined) {
		return { start: Math.max(0, length - anchor.count), end: length };
	}
	const at = records.indexOf(anchor.first);
	// A first row the store has dropped leaves the window at the end it was dropped from.
	const start = at !== -1 ? at : droppedNewest(records, anchor.first) ? length - anchor.count : 0;
	return { start: Math.max(0, start), end: Math.min(length, start + anchor.count) };
}

/** The top sentinel reached: a step older, giving up the newest rows past the cap. */
function grownUp(records: readonly LogEntry[], anchor: Anchor, follow: boolean): Anchor {
	const { start } = boundsOf(records, anchor, follow);
	if (start === 0) return anchor;
	const top = Math.max(0, start - LOG_WINDOW_STEP);
	const count = Math.min(LOG_WINDOW_MAX_ROWS, anchor.count + start - top);
	return { ...anchor, first: records[top], count };
}

/** The bottom sentinel reached: a step newer, giving up the oldest rows past the cap. */
function grownDown(records: readonly LogEntry[], anchor: Anchor, follow: boolean): Anchor {
	const { start, end } = boundsOf(records, anchor, follow);
	if (end >= records.length) return anchor;
	const bottom = Math.min(records.length, end + LOG_WINDOW_STEP);
	const top = Math.max(start, bottom - LOG_WINDOW_MAX_ROWS);
	return { ...anchor, first: records[top], count: bottom - top };
}

/**
 * A callback ref that calls @p onReached whenever its element scrolls into
 * view. A callback ref, as `useGrowingWindow`'s is, so a sentinel that
 * unmounts and mounts again is observed again.
 */
function useSentinel(onReached: () => void): (node: HTMLElement | null) => void {
	const observer = useRef<IntersectionObserver | null>(null);
	const sentinelRef = useCallback(
		(node: HTMLElement | null) => {
			observer.current?.disconnect();
			observer.current = null;
			if (!node) return;
			observer.current = new IntersectionObserver((entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onReached();
			});
			observer.current.observe(node);
		},
		[onReached]
	);
	useEffect(() => () => observer.current?.disconnect(), []);
	return sentinelRef;
}

export interface LogWindow {
	/** The rows to mount, oldest first. */
	shown: LogEntry[];
	/** Held rows sit above the window: render the top sentinel, with `topSentinelRef`. */
	hasAbove: boolean;
	/** Held rows sit below the window: render the bottom sentinel, with `bottomSentinelRef`. */
	hasBelow: boolean;
	topSentinelRef: (node: HTMLElement | null) => void;
	bottomSentinelRef: (node: HTMLElement | null) => void;
}

/**
 * The window over @p records, oldest first; @p generation changes whenever the
 * store replaces the list, and starts the window again at the newest step.
 */
export function useLogWindow(
	records: LogEntry[],
	follow: boolean,
	generation: number,
	/** Called just before the top sentinel grows the window: `useHoldPlace`'s function. */
	beforeGrowUp?: () => void
): LogWindow {
	const [anchor, setAnchor] = useState(() => initialAnchor(generation));

	// What the observers' callbacks grow against: they run after the render that armed them.
	const latest = useRef({ records, follow });
	useEffect(() => {
		latest.current = { records, follow };
	});
	const growUp = useCallback(() => {
		beforeGrowUp?.();
		setAnchor((prev) => grownUp(latest.current.records, prev, latest.current.follow));
	}, [beforeGrowUp]);
	const growDown = useCallback(
		() => setAnchor((prev) => grownDown(latest.current.records, prev, latest.current.follow)),
		[]
	);
	const topSentinelRef = useSentinel(growUp);
	const bottomSentinelRef = useSentinel(growDown);

	/*
	 * No observer, no window: jsdom has none, and withholding rows nothing can
	 * reach would turn a missing optimisation into missing data, as
	 * `useGrowingWindow` reasons. Chromium always has one.
	 */
	if (typeof IntersectionObserver === "undefined") {
		return {
			shown: records,
			hasAbove: false,
			hasBelow: false,
			topSentinelRef,
			bottomSentinelRef,
		};
	}

	const current = anchor.generation === generation ? anchor : initialAnchor(generation);
	const { start, end } = boundsOf(records, current, follow);
	/*
	 * Re-anchored during render, as `useGrowingWindow` resets: while following
	 * the first row moves with every batch, and holding it means the window is
	 * already anchored on the reader's rows when Follow turns off.
	 */
	if (current !== anchor || records[start] !== current.first) {
		setAnchor({ ...current, first: records[start] });
	}
	return {
		shown: records.slice(start, end),
		hasAbove: start > 0,
		hasBelow: end < records.length,
		topSentinelRef,
		bottomSentinelRef,
	};
}
