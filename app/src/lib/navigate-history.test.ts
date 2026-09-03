/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One press, one step (#1245).
 *
 * A thumb-button click on Windows arrives twice - once as Chromium's `mouseup`
 * in the renderer, once as the window's `app-command` forwarded from the main
 * process - and both handlers are the right one somewhere, so neither can be
 * dropped. What must not happen is two steps for one press.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { navigateHistory, resetNavigationEcho } from "./navigate-history";
import { useTabsStore } from "@/stores";

/** Three places visited, sitting at the last of them. */
beforeEach(() => {
	resetNavigationEcho();
	useTabsStore.setState({
		openTabs: [],
		activeTabId: null,
		tabFocusedAt: {},
		navHistory: [
			{ type: "request", entityId: "a" },
			{ type: "request", entityId: "b" },
			{ type: "request", entityId: "c" },
		],
		navIndex: 2,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

const index = () => useTabsStore.getState().navIndex;

describe("the echo window", () => {
	it("takes one step for a press reported by both the mouse and the OS", () => {
		navigateHistory("back", "pointer");
		navigateHistory("back", "os");

		expect(index()).toBe(1);
	});

	it("takes the second step once the echo window has passed", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));

		navigateHistory("back", "pointer");
		vi.setSystemTime(new Date("2026-09-03T12:00:00.200Z"));
		navigateHistory("back", "pointer");

		expect(index()).toBe(0);
	});

	it("does not collapse opposite directions", () => {
		navigateHistory("back", "pointer");
		navigateHistory("forward", "os");

		expect(index()).toBe(2);
	});

	it("leaves a held chord alone, so Back repeats the way a browser's does", () => {
		navigateHistory("back", "chord");
		navigateHistory("back", "chord");

		expect(index()).toBe(0);
	});

	it("leaves the buttons and the palette alone", () => {
		navigateHistory("back", "ui");
		navigateHistory("back", "ui");

		expect(index()).toBe(0);
	});
});
