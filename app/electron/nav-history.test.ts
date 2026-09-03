/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The gestures only the main process hears (#1245).
 *
 * Both mappings are directional and both are easy to get backwards, which is
 * the whole reason they are a named function each rather than two `if`s inside
 * a listener: a swipe's direction is the fingers', so it is the opposite of the
 * navigation it means.
 */

import { describe, it, expect, vi } from "vitest";
import {
	navigationForAppCommand,
	navigationForSwipe,
	watchNavigationGestures,
	type GestureEvent,
	type NavDirection,
} from "./nav-history";

describe("app-command", () => {
	it("maps the browser commands the thumb buttons send", () => {
		expect(navigationForAppCommand("browser-backward")).toBe("back");
		expect(navigationForAppCommand("browser-forward")).toBe("forward");
	});

	it("ignores every other command the OS sends", () => {
		// The window receives these too - `app-command` is not a navigation event.
		expect(navigationForAppCommand("browser-refresh")).toBeNull();
		expect(navigationForAppCommand("media-play-pause")).toBeNull();
	});
});

describe("swipe", () => {
	it("reads the fingers, not the navigation: right uncovers what came before", () => {
		expect(navigationForSwipe("right")).toBe("back");
		expect(navigationForSwipe("left")).toBe("forward");
	});

	it("ignores the vertical pair", () => {
		expect(navigationForSwipe("up")).toBeNull();
		expect(navigationForSwipe("down")).toBeNull();
	});
});

/** A window that records its listeners so a test can fire them. */
function fakeWindow() {
	const listeners = new Map<string, (event: GestureEvent, detail: string) => void>();
	return {
		on(event: "app-command" | "swipe", listener: (e: GestureEvent, detail: string) => void) {
			listeners.set(event, listener);
			return this;
		},
		fire(event: "app-command" | "swipe", detail: string) {
			listeners.get(event)?.({}, detail);
		},
	};
}

describe("watching a window", () => {
	it("reports a navigating gesture once, and nothing for the others", () => {
		const window = fakeWindow();
		const navigate = vi.fn<(direction: NavDirection) => void>();
		watchNavigationGestures(window, navigate);

		window.fire("app-command", "browser-backward");
		window.fire("swipe", "left");
		window.fire("app-command", "browser-refresh");
		window.fire("swipe", "up");

		expect(navigate.mock.calls).toEqual([["back"], ["forward"]]);
	});
});
