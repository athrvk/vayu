/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two navigation gestures only the main process can hear (#1245).
 *
 * The renderer sees the mouse's thumb buttons as ordinary pointer buttons and
 * handles them itself. These two it cannot see at all:
 *
 * - **`app-command`** is how Windows and Linux deliver the same thumb buttons
 *   when the OS routes them as application commands rather than as mouse
 *   buttons, which is what a driver's default profile does on Windows.
 * - **`swipe`** is the macOS three-finger swipe, delivered to the window by
 *   AppKit and never as a DOM event. It fires only while the system's "swipe
 *   between pages" gesture is enabled, so honouring it is honouring that
 *   setting rather than inventing a gesture.
 *
 * Kept out of main.ts so it can be tested, the way `window-navigation.ts` is:
 * main.ts creates windows and starts the engine at import time, which no unit
 * test can do.
 */

export type NavDirection = "back" | "forward";

/** What a listener is handed, without depending on Electron's types. */
export interface GestureEvent {
	preventDefault?(): void;
}

/** The slice of `BrowserWindow` this needs, so a test can pass a fake. */
export interface GesturingWindow {
	on(
		event: "app-command" | "swipe",
		listener: (event: GestureEvent, detail: string) => void
	): unknown;
}

/** Which way an `app-command` navigates, or `null` for the many that do not. */
export function navigationForAppCommand(command: string): NavDirection | null {
	if (command === "browser-backward") return "back";
	if (command === "browser-forward") return "forward";
	return null;
}

/**
 * Which way a swipe navigates, or `null` for a vertical one.
 *
 * The direction is the fingers', not the navigation's, so the two are opposites:
 * dragging the page to the right uncovers what was before it, which is Back.
 * That is what Safari and Chrome do with the same gesture on the same hardware,
 * and matching them is the whole reason to answer the gesture at all.
 */
export function navigationForSwipe(direction: string): NavDirection | null {
	if (direction === "right") return "back";
	if (direction === "left") return "forward";
	return null;
}

/**
 * Report the window's navigation gestures to `navigate`.
 *
 * Both events are subscribed unconditionally rather than per platform: each
 * fires only where its platform delivers it, and a `process.platform` branch
 * here would be a second, quieter statement of that same fact - one that goes
 * wrong the first time a platform gains the other gesture.
 */
export function watchNavigationGestures(
	window: GesturingWindow,
	navigate: (direction: NavDirection) => void
): void {
	window.on("app-command", (_event, command) => {
		const direction = navigationForAppCommand(command);
		if (direction) navigate(direction);
	});
	window.on("swipe", (_event, direction) => {
		const step = navigationForSwipe(direction);
		if (step) navigate(step);
	});
}
