/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What is at stake is the renderer's pending autosave at Windows logoff: the
 * process exits as soon as `session-end` returns, and `before-quit` never runs
 * for a session ending (#2433), so only `query-session-end` can still wait.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installQuitOnSessionEnd } from "./session-end.js";

function fakeWindow() {
	let listener: ((event: { preventDefault: () => void }) => void) | undefined;
	return {
		on(_event: "query-session-end", fn: (event: { preventDefault: () => void }) => void) {
			listener = fn;
			return this;
		},
		query() {
			const event = { preventDefault: vi.fn() };
			listener?.(event);
			return event;
		},
	};
}

describe("installQuitOnSessionEnd", () => {
	it("holds the session open and quits through the normal path", () => {
		const quit = vi.fn();
		const win = fakeWindow();
		installQuitOnSessionEnd(win, quit);
		const event = win.query();
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it("does nothing until the session is asked to end", () => {
		const quit = vi.fn();
		installQuitOnSessionEnd(fakeWindow(), quit);
		expect(quit).not.toHaveBeenCalled();
	});

	it("keeps holding on a second query but starts one shutdown", () => {
		const quit = vi.fn();
		const win = fakeWindow();
		installQuitOnSessionEnd(win, quit);
		win.query();
		const second = win.query();
		expect(second.preventDefault).toHaveBeenCalledTimes(1);
		expect(quit).toHaveBeenCalledTimes(1);
	});
});

describe("main.ts wiring", () => {
	const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
	const wiring = main.slice(main.indexOf("installQuitOnSessionEnd(mainWindow"));

	it("installs it on the main window", () => {
		expect(main).toContain("installQuitOnSessionEnd(mainWindow");
	});

	it("asks no question, because nobody can answer at logoff", () => {
		expect(wiring).toContain("serviceStopGuard.markQuitUnattended()");
		expect(wiring).toContain("flushFailureGate.markQuitUnattended()");
	});
});
