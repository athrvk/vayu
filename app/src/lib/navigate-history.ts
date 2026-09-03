/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one way into Back and Forward (#1245).
 *
 * Five surfaces ask for the same two steps - the title-bar buttons, the chords,
 * the palette, the View menu, and the mouse's own back/forward buttons - and one
 * of them arrives twice for a single press: on Windows a thumb-button click
 * reaches the app both as Chromium's `mouseup` in the renderer and as the
 * window's `app-command` in the main process, which forwards it over IPC. Either
 * alone is the right handler on some platform, so neither can be dropped, and
 * the two together move two steps for one press.
 *
 * So the collapse happens here, where both land, rather than in the store: the
 * store cannot tell a duplicate report of one press from a user pressing Back
 * twice, and it should not have to.
 */

import { useTabsStore } from "@/stores";

export type NavDirection = "back" | "forward";

/**
 * What asked to navigate.
 *
 * Only the two hardware routes are de-duplicated against each other. A chord
 * repeats while held, and holding Back to walk a history back is the behaviour
 * every browser has; the buttons and the palette cannot fire twice in a frame at
 * all.
 */
export type NavSource = "chord" | "pointer" | "os" | "ui";

/**
 * How long after a hardware step the same step is treated as an echo of it.
 *
 * One press, two reports, about a frame apart - IPC from the main process is not
 * instant, so a strict frame is too tight, while a double click of a thumb
 * button is 150ms apart at its fastest. 100ms sits between the two with room on
 * both sides.
 */
const ECHO_WINDOW_MS = 100;

let lastHardwareStep: { direction: NavDirection; at: number } | null = null;

/** Reset the echo window - for tests, which have no frames between cases. */
export function resetNavigationEcho(): void {
	lastHardwareStep = null;
}

export function navigateHistory(direction: NavDirection, source: NavSource): void {
	if (source === "pointer" || source === "os") {
		const now = Date.now();
		if (
			lastHardwareStep &&
			lastHardwareStep.direction === direction &&
			now - lastHardwareStep.at < ECHO_WINDOW_MS
		) {
			return;
		}
		lastHardwareStep = { direction, at: now };
	}

	const { goBack, goForward } = useTabsStore.getState();
	if (direction === "back") goBack();
	else goForward();
}
