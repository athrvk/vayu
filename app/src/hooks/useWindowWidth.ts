/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
	window.addEventListener("resize", onChange);
	return () => window.removeEventListener("resize", onChange);
}

function windowWidth(): number {
	return window.innerWidth;
}

/**
 * The window's width in CSS px, re-read on every resize. CSS px, not device
 * px: at a 200% scale a 1024px screen reports 512, which is the width the
 * layout actually has to fit.
 */
export function useWindowWidth(): number {
	return useSyncExternalStore(subscribe, windowWidth);
}
