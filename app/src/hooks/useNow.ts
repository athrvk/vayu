/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";

/** The longest delay `setTimeout` honours; a larger one fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The current time, re-read once the clock reaches @p instant (epoch ms), so a
 * state that flips at a known moment flips on screen at that moment instead of
 * at the next unrelated render. Nothing polls: one timer is armed for the
 * instant, and none once it has passed or while @p instant is null.
 *
 * Between instants the value is what the last render read, not a live clock;
 * pass the instant a view depends on and read nothing else from it.
 */
export function useNow(instant: number | null): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (instant === null || now >= instant) return;
		// A wait past the timer's ceiling wakes early, finds the instant still
		// ahead, and the new `now` re-arms the effect for the rest.
		const wait = Math.min(Math.max(instant - Date.now(), 0), MAX_TIMEOUT_MS);
		const timer = setTimeout(() => setNow(Date.now()), wait);
		return () => clearTimeout(timer);
	}, [instant, now]);

	return now;
}
