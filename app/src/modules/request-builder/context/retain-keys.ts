/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The open-tab sweep's answer for a per-request map held as state (issue
 * #1271).
 *
 * `useAutoRecordSlot`'s `retain` is the same rule over a ref: it deletes in
 * place, and a ref that shrinks re-renders nothing. `rowIndexByRequest` is
 * `useState` instead - `lastRowIndex` is read during render - so its sweep is a
 * `setState`, and a `setState` that returns a new object every time a tab is
 * focused would charge the request the user is working in for a map that did
 * not change. Hence the identity guard: `previous` itself when every key is
 * still live, which React compares with `Object.is` and bails out on.
 */
export function retainKeys<T>(
	previous: Record<string, T>,
	live: ReadonlySet<string>
): Record<string, T> {
	const kept = Object.entries(previous).filter(([key]) => live.has(key));
	if (kept.length === Object.keys(previous).length) return previous;
	return Object.fromEntries(kept);
}
