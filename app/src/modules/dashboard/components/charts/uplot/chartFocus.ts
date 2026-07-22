/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-chart focus channel - a tiny pub/sub keyed by chart group, carrying the
 * hovered **timestamp** (elapsed seconds).
 *
 * uPlot's native cursor sync matches on the x-scale VALUE, which only links
 * charts that share an x axis (time). The concurrency scatter plots against
 * concurrency, so it can't join that group - but every scatter dot still
 * corresponds to a moment in time. This channel carries that moment, so hovering
 * a time chart can highlight the scatter's dot for the same tick (and vice
 * versa), keyed by timestamp rather than pixel or x-value.
 */

export type FocusValue = number | null;
type Listener = (t: FocusValue, origin: symbol) => void;

const groups = new Map<string, Set<Listener>>();

/** Subscribe to a group's focus. Returns an unsubscribe fn. */
export function subscribeFocus(key: string, listener: Listener): () => void {
	let set = groups.get(key);
	if (!set) {
		set = new Set();
		groups.set(key, set);
	}
	set.add(listener);
	return () => {
		set!.delete(listener);
		if (set!.size === 0) groups.delete(key);
	};
}

/** Broadcast the focused timestamp to a group. `origin` lets a chart ignore its own echo. */
export function publishFocus(key: string, t: FocusValue, origin: symbol): void {
	const set = groups.get(key);
	if (!set) return;
	for (const listener of set) listener(t, origin);
}
