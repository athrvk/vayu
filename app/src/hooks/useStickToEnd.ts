/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Follow the end of a scroller while the reader is at it (#3671): the Console's
 * and the Logs tab's lists.
 *
 * Rows are `skip-offscreen` (`content-visibility: auto`), so a row that was
 * pinned to is laid out at its estimated height and settles to its real one a
 * frame later, and the scroller's `scrollHeight` grows after the pin. Two things
 * follow from that:
 *
 * - The list is pinned again when its box resizes, not only when the rows
 *   change: `listRef` goes on the element that holds the rows.
 * - "At the end" is decided from the reader's own scrolls. The scroll event our
 *   pin causes arrives after the growth and reads a gap the reader never made,
 *   so a scroll that lands on the position we just set is ours and changes
 *   nothing. A tolerance cannot stand in for this: the gap scales with what
 *   arrived, and an expanded row is any height. A scroll the caller makes
 *   (a jump centring its marker, #3674) goes through `scrollOwn`, which marks
 *   its event the same way: where it ends near the end it must not read as the
 *   reader arriving there and turn Follow on.
 *
 * `following` is the caller's state, because the Logs tab keeps it in a store;
 * the hook asks to change it through `onFollowingChange`. @p canResume lets a
 * caller refuse the scroll that reaches the end (a list detached from the tail).
 * Call the hook after any effect that moves the scroller (`useHoldPlace`): the
 * pin runs last and wins.
 */

import {
	type RefCallback,
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	type UIEventHandler,
} from "react";

/** How far from the end still counts as at the end: a fractional scroll position never lands exactly. */
export const END_TOLERANCE_PX = 8;

interface StickToEndOptions {
	/** Whether the list is pinned to its end. */
	following: boolean;
	onFollowingChange: (following: boolean) => void;
	/** A scroll to the end resumes following only when this is true. */
	canResume?: boolean;
	/** The rows: a new value pins the list while following. */
	rows: unknown;
}

interface StickToEnd {
	onScroll: UIEventHandler<HTMLElement>;
	/** Goes on the element that holds the rows, so a resize of the list pins it again. */
	listRef: RefCallback<HTMLElement>;
	/** Runs @p move, a scroll of the scroller, and keeps the scroll event it causes from changing `following`. */
	scrollOwn: (move: () => void) => void;
}

export function useStickToEnd(
	scroller: RefObject<HTMLElement | null>,
	{ following, onFollowingChange, canResume = true, rows }: StickToEndOptions
): StickToEnd {
	// The scroll handler and the observer run between renders, where the props are stale.
	const followingRef = useRef(following);
	const canResumeRef = useRef(canResume);
	const onChangeRef = useRef(onFollowingChange);
	/** Where the last pin left `scrollTop`: the scroll event that reports it is ours. */
	const pinnedTop = useRef<number | null>(null);
	/** Where the caller's last scroll left `scrollTop`, until the event that reports it. */
	const ownTop = useRef<number | null>(null);
	const observer = useRef<ResizeObserver | null>(null);
	// The caller's ref object lives as long as the component does; holding it once keeps `pin` stable.
	const scrollerRef = useRef(scroller);

	const pin = useCallback(() => {
		const element = scrollerRef.current.current;
		if (!element) return;
		element.scrollTop = element.scrollHeight;
		pinnedTop.current = element.scrollTop;
	}, []);

	useLayoutEffect(() => {
		followingRef.current = following;
		canResumeRef.current = canResume;
		onChangeRef.current = onFollowingChange;
		if (following) pin();
	}, [following, canResume, onFollowingChange, rows, pin]);

	const listRef = useCallback(
		(list: HTMLElement | null) => {
			observer.current?.disconnect();
			observer.current = null;
			if (!list) return;
			observer.current = new ResizeObserver(() => {
				if (followingRef.current) pin();
			});
			observer.current.observe(list);
		},
		[pin]
	);

	const scrollOwn = useCallback((move: () => void) => {
		const element = scrollerRef.current.current;
		if (!element) return;
		move();
		ownTop.current = element.scrollTop;
	}, []);

	const onScroll = useCallback<UIEventHandler<HTMLElement>>((event) => {
		const element = event.currentTarget;
		const own = ownTop.current;
		ownTop.current = null;
		if (own === element.scrollTop) return;
		if (followingRef.current && element.scrollTop === pinnedTop.current) return;
		const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
		const atEnd = gap <= END_TOLERANCE_PX;
		const next = followingRef.current ? atEnd : atEnd && canResumeRef.current;
		if (next === followingRef.current) return;
		followingRef.current = next;
		onChangeRef.current(next);
	}, []);

	return { onScroll, listRef, scrollOwn };
}
