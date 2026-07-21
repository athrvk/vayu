/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether the operating system asks for reduced motion.
 *
 * The collapsing itself is CSS — a `@media (prefers-reduced-motion: reduce)`
 * block in `index.css`, alongside the rule the in-app toggle drives. Nothing
 * needs JavaScript to stop animating.
 *
 * This exists so the *settings UI* can be honest. Without it the Reduced motion
 * row reads "off" while the app is visibly not animating, and the only
 * explanation lives in another application's settings.
 *
 * `useSyncExternalStore` rather than state-plus-effect: the media query is an
 * external source of truth, so React should read it directly. The effect
 * version had to re-read on mount to close the gap between the initial render
 * and the subscription, which is a setState inside an effect — a cascading
 * render on every mount, and the lint rule that flags it is right.
 */

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
	const mql = window.matchMedia?.(QUERY);
	if (!mql) return () => {};
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
}

/** Read live, so a preference changed while the app is open is picked up. */
function getSnapshot(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true;
}

export function usePrefersReducedMotion(): boolean {
	// Server snapshot is `false`: without a window there is no preference to
	// honour, and the CSS is what does the work anyway.
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
