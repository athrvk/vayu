/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function with one identity for the component's whole life that always runs
 * the `fn` of the latest committed render.
 *
 * For a handler that reads state but is only ever *called* from an event, never
 * during render. Listing that state in a `useCallback` makes the handler a new
 * function whenever the state changes, and a new function in a context value
 * re-renders every consumer; reading it through the latest render instead keeps
 * the identity fixed and the behaviour current (#2543).
 *
 * **Do not call the result while rendering.** The ref is written in a layout
 * effect, so a call made during render sees the previous commit's `fn`. A
 * function a row calls to build its menu belongs in `useCallback` with its
 * real dependencies, so that it changes exactly when its answer does.
 */
export function useStableCallback<A extends unknown[], R>(
	fn: (...args: A) => R
): (...args: A) => R {
	const latest = useRef(fn);
	useLayoutEffect(() => {
		latest.current = fn;
	});
	return useCallback((...args: A) => latest.current(...args), []);
}
