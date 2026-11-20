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
 *
 * **A jump opens the window on its time** (`jumpTarget`, #3674), not on the
 * newest rows: a few rows before the first line at or after it, so the line the
 * reader asked for is mounted whatever is newer. Until such a line is held (the
 * page newer is still being read) the window is the newest rows and holds no
 * first row, so the page's arrival moves it onto the time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import type { LogEntry } from "@/types/electron";
import { firstAtOrAfter } from "./log-entry";

/** The first window after the list is replaced, and how far a sentinel grows it. */
export const LOG_WINDOW_STEP = GROWING_WINDOW_STEP;
/** The most rows mounted at once. */
export const LOG_WINDOW_MAX_ROWS = 3 * LOG_WINDOW_STEP;
/** The rows a jump's window mounts above the time, for the reader to see it in context. */
const JUMP_CONTEXT_ROWS = LOG_WINDOW_STEP / 4;

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
	/** The window is the newest rows only because the jump's time has no line yet. */
	awaitsTarget?: boolean;
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

/**
 * The window that opens on the line at or after @p target, kept full where rows
 * are held above it; null while no line is.
 */
function boundsAroundTarget(
	records: readonly LogEntry[],
	count: number,
	target: string | null
): Bounds | null {
	if (target === null) return null;
	const at = firstAtOrAfter(records, target);
	if (at === records.length) return null;
	const start = Math.max(0, Math.min(at - JUMP_CONTEXT_ROWS, records.length - count));
	return { start, end: Math.min(records.length, start + count) };
}

function newestBounds(length: number, count: number): Bounds {
	return { start: Math.max(0, length - count), end: length };
}

function boundsOf(
	records: readonly LogEntry[],
	anchor: Anchor,
	follow: boolean,
	target: string | null
): Bounds {
	const length = records.length;
	if (follow) return newestBounds(length, anchor.count);
	if (anchor.first === undefined) {
		return (
			boundsAroundTarget(records, anchor.count, target) ?? {
				...newestBounds(length, anchor.count),
				awaitsTarget: target !== null,
			}
		);
	}
	const at = records.indexOf(anchor.first);
	// A first row the store has dropped leaves the window at the end it was dropped from.
	const start = at !== -1 ? at : droppedNewest(records, anchor.first) ? length - anchor.count : 0;
	return { start: Math.max(0, start), end: Math.min(length, start + anchor.count) };
}

/** The top sentinel reached: a step older, giving up the newest rows past the cap. */
function grownUp(
	records: readonly LogEntry[],
	anchor: Anchor,
	follow: boolean,
	target: string | null
): Anchor {
	const { start } = boundsOf(records, anchor, follow, target);
	if (start === 0) return anchor;
	const top = Math.max(0, start - LOG_WINDOW_STEP);
	const count = Math.min(LOG_WINDOW_MAX_ROWS, anchor.count + start - top);
	return { ...anchor, first: records[top], count };
}

/** The bottom sentinel reached: a step newer, giving up the oldest rows past the cap. */
function grownDown(
	records: readonly LogEntry[],
	anchor: Anchor,
	follow: boolean,
	target: string | null
): Anchor {
	const { start, end } = boundsOf(records, anchor, follow, target);
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

/** Where @p target falls among the @p shownLength rows from @p start, or null when not beside them. */
function markerIndex(
	records: readonly LogEntry[],
	start: number,
	shownLength: number,
	target: string | null
): number | null {
	if (target === null) return null;
	const at = firstAtOrAfter(records, target) - start;
	return at >= 0 && at <= shownLength ? at : null;
}

export interface LogWindow {
	/** The rows to mount, oldest first. */
	shown: LogEntry[];
	/** Held rows sit above the window: render the top sentinel, with `topSentinelRef`. */
	hasAbove: boolean;
	/** Held rows sit below the window: render the bottom sentinel, with `bottomSentinelRef`. */
	hasBelow: boolean;
	/**
	 * Where the jump's time falls among `shown`: the marker goes before the row
	 * at this index, after the last when it is `shown.length`. Null with no jump,
	 * or while the window is elsewhere.
	 */
	jumpAt: number | null;
	topSentinelRef: (node: HTMLElement | null) => void;
	bottomSentinelRef: (node: HTMLElement | null) => void;
}

/**
 * The window over @p records, oldest first; @p generation changes whenever the
 * store replaces the list, and starts the window again: at the newest step, or
 * on @p jumpTarget, the instant a jump landed on, while not following.
 */
export function useLogWindow(
	records: LogEntry[],
	follow: boolean,
	generation: number,
	/** Called just before the top sentinel grows the window: `useHoldPlace`'s function. */
	beforeGrowUp?: () => void,
	jumpTarget: string | null = null
): LogWindow {
	const [anchor, setAnchor] = useState(() => initialAnchor(generation));

	// What the observers' callbacks grow against: they run after the render that armed them.
	const latest = useRef({ records, follow, jumpTarget });
	useEffect(() => {
		latest.current = { records, follow, jumpTarget };
	});
	const growUp = useCallback(() => {
		beforeGrowUp?.();
		setAnchor((prev) => {
			const { records, follow, jumpTarget } = latest.current;
			return grownUp(records, prev, follow, jumpTarget);
		});
	}, [beforeGrowUp]);
	const growDown = useCallback(
		() =>
			setAnchor((prev) => {
				const { records, follow, jumpTarget } = latest.current;
				return grownDown(records, prev, follow, jumpTarget);
			}),
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
			jumpAt: markerIndex(records, 0, records.length, jumpTarget),
			topSentinelRef,
			bottomSentinelRef,
		};
	}

	const current = anchor.generation === generation ? anchor : initialAnchor(generation);
	const { start, end, awaitsTarget } = boundsOf(records, current, follow, jumpTarget);
	/*
	 * Re-anchored during render, as `useGrowingWindow` resets: while following
	 * the first row moves with every batch, and holding it means the window is
	 * already anchored on the reader's rows when Follow turns off. Not while a
	 * jump awaits its time: the row it will open on is not held yet.
	 */
	if (current !== anchor || (!awaitsTarget && records[start] !== current.first)) {
		setAnchor({ ...current, first: awaitsTarget ? undefined : records[start] });
	}
	const shown = records.slice(start, end);
	return {
		shown,
		hasAbove: start > 0,
		hasBelow: end < records.length,
		jumpAt: markerIndex(records, start, shown.length, jumpTarget),
		topSentinelRef,
		bottomSentinelRef,
	};
}
