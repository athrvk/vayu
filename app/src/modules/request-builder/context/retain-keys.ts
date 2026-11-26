/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The open-tab sweep for a per-request map held as state (#1271). `rowIndexByRequest` is `useState`
 * since `lastRowIndex` is read during render, so its sweep is a `setState`, and a new object on
 * every tab focus would re-render the working request for an unchanged map. Hence the identity
 * guard: `previous` itself when every key is live, which React's `Object.is` bails out on.
 */
export function retainKeys<T>(
	previous: Record<string, T>,
	live: ReadonlySet<string>
): Record<string, T> {
	const kept = Object.entries(previous).filter(([key]) => live.has(key));
	if (kept.length === Object.keys(previous).length) return previous;
	return Object.fromEntries(kept);
}
