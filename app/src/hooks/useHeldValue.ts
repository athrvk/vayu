/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";

/** What `useHeldValue` reports: what to draw, and whether it is on its way out. */
export interface HeldValue<T> {
	/**
	 * The value to render right now - `value` itself, or the last non-`null`
	 * one for `holdMs` after `value` goes `null`.
	 */
	shown: T | null;
	/**
	 * True for exactly that hold window: the caller's own state says there is
	 * nothing left to show, but `shown` has not caught up yet. Key an opacity
	 * transition off this.
	 */
	fading: boolean;
}

/**
 * Keep the last thing on screen for a moment after the state behind it says
 * there is nothing left, so a CSS fade has something to animate against.
 *
 * **The defect this exists for.** A conditionally-rendered node
 * (`{count ? <span>{count}</span> : null}`, `{hasResults && <Badge/>}`) is
 * removed from the tree in the same commit that its state goes back to its
 * empty value. If a container around it is animating at that moment - a
 * `grid-template-columns: 1fr -> 0fr` track collapsing, an opacity fading -
 * the surrounding motion reads as "this is fading away" while the content
 * itself was a hard cut one frame in. The container's own transition is what
 * makes it easy to miss: something *is* moving, just not the part that
 * carries the meaning. `transition-opacity` on the content alone does not fix
 * it either, because by the time the class flips there is nothing inside the
 * box to fade.
 *
 * The fix is to separate *what is true* from *what is drawn*: the caller's
 * live value drives the container (so the collapse starts immediately, on
 * time), and `shown` holds the outgoing content for `holdMs` so the fade has
 * a populated node. `fading` is the boolean the opacity class keys off, true
 * for exactly that window.
 *
 * `layout/Dock.tsx`'s `useSaveStatusDisplay` is the same shape specialised to
 * the save store (it also floors how long "Saving…" stays up, which is its
 * own concern); this is the general form the marks use. See "Motion
 * vocabulary" in `docs/design-system.md`.
 *
 * **`T` is a primitive on purpose.** The held value is compared with
 * `Object.is`, so an object or an element rebuilt on every render would never
 * settle. A caller whose content is richer than a string passes the one
 * primitive that identifies it and rebuilds the rest from `shown`.
 *
 * No generation counter: a `useEffect` cleanup already cancels a scheduled
 * clear whenever the value changes again before it fires, which is the whole
 * mechanism.
 */
export function useHeldValue<T extends string | number>(
	value: T | null,
	holdMs: number
): HeldValue<T> {
	const [shown, setShown] = useState<T | null>(value);

	/*
	 * Arriving content is adopted during render, not in an effect: an effect
	 * would paint one frame with the old value still in place, which for a
	 * count changing under a keystroke is a visible lag. This is React's
	 * documented "adjusting state while rendering" - the setter runs on the
	 * same node it belongs to and React re-renders before committing, so
	 * nothing downstream sees the stale value.
	 */
	if (value !== null && !Object.is(value, shown)) setShown(value);

	useEffect(() => {
		// The only held case: live is empty, `shown` is not yet.
		if (value !== null || shown === null) return;
		const timer = setTimeout(() => setShown(null), holdMs);
		return () => clearTimeout(timer);
	}, [value, shown, holdMs]);

	return { shown, fading: value === null && shown !== null };
}
