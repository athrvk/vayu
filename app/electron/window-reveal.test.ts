/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The window reaches the screen either way (#1347).
 *
 * The failure this covers has no visible symptom to assert against in the app:
 * a first frame that never arrives leaves `ready-to-show` unfired, so the
 * window is never shown and nothing at all is logged - the app looks started
 * and is invisible. So the two paths are driven here directly, and `main.ts`'s
 * end of the wiring is read the way `startup-order.test.ts` reads the rest of
 * its startup, because main.ts creates windows at import time and cannot be
 * imported.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVEAL_FALLBACK_MS, revealWhenReady, type RevealReason } from "./window-reveal.js";

/** A BrowserWindow double that records the show and can be destroyed. */
function fakeWindow(options: { destroyed?: boolean } = {}) {
	let destroyed = options.destroyed ?? false;
	const listeners: Array<() => void> = [];
	const shows = vi.fn();

	return {
		once: (_event: "ready-to-show", listener: () => void) => void listeners.push(listener),
		isDestroyed: () => destroyed,
		show: shows,
		/** Fire `ready-to-show`, as Chromium would on a first frame. */
		paint: () => listeners.forEach((listener) => listener()),
		destroy: () => void (destroyed = true),
		shows,
	};
}

/** Collect the fallback timer instead of running it, so a test can fire it. */
function heldTimer() {
	const armed: Array<{ ms: number; fire: () => void }> = [];
	return {
		after: (ms: number, fn: () => void) => void armed.push({ ms, fire: fn }),
		armed,
		fireAll: () => armed.forEach((timer) => timer.fire()),
	};
}

function reveal(window: ReturnType<typeof fakeWindow>, timer = heldTimer()) {
	const revealed: RevealReason[] = [];
	const warnings: string[] = [];
	revealWhenReady(window, (reason) => revealed.push(reason), {
		after: timer.after,
		warn: (message) => warnings.push(message),
	});
	return { revealed, warnings, timer };
}

describe("revealing the window", () => {
	it("shows it on the first frame, and says nothing", () => {
		const window = fakeWindow();
		const { revealed, warnings } = reveal(window);

		expect(window.shows).not.toHaveBeenCalled();
		window.paint();

		expect(window.shows).toHaveBeenCalledTimes(1);
		expect(revealed).toEqual(["ready-to-show"]);
		// The ordinary launch is every launch on a desktop. A warning here would
		// be in every user's log.
		expect(warnings).toEqual([]);
	});

	it("shows it anyway when no frame ever arrives, and says why", () => {
		// The whole point: without this the app is up, the renderer is running,
		// and the screen stays empty with nothing written about it.
		const window = fakeWindow();
		const { revealed, warnings, timer } = reveal(window);

		timer.fireAll();

		expect(window.shows).toHaveBeenCalledTimes(1);
		expect(revealed).toEqual(["reveal-fallback"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(String(REVEAL_FALLBACK_MS));
		expect(warnings[0]).toContain("#1347");
	});

	it("waits the stated budget before it gives up on a frame", () => {
		const timer = heldTimer();
		reveal(fakeWindow(), timer);

		expect(timer.armed.map((armed) => armed.ms)).toEqual([REVEAL_FALLBACK_MS]);
	});

	it("shows it once when the frame arrives late", () => {
		// Both paths stay armed - the timer cannot be cleared through the window
		// - so a frame landing after the fallback must not re-show the window or
		// print a second startup line over the first.
		const window = fakeWindow();
		const { revealed, timer } = reveal(window);

		timer.fireAll();
		window.paint();

		expect(window.shows).toHaveBeenCalledTimes(1);
		expect(revealed).toEqual(["reveal-fallback"]);
	});

	it("shows it once when the frame arrives on time", () => {
		const window = fakeWindow();
		const { revealed, timer } = reveal(window);

		window.paint();
		timer.fireAll();

		expect(window.shows).toHaveBeenCalledTimes(1);
		expect(revealed).toEqual(["ready-to-show"]);
	});

	it("does not show a window that is already gone", () => {
		// A launch closed inside the fallback budget leaves the timer holding a
		// destroyed window; `show()` on one throws, and a throw from a timer
		// callback in the main process takes the app down.
		const window = fakeWindow();
		const { revealed, timer } = reveal(window);

		window.destroy();
		timer.fireAll();

		expect(window.shows).not.toHaveBeenCalled();
		expect(revealed).toEqual([]);
	});
});

describe("main.ts's end of it", () => {
	const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

	it("reveals the window through this module", () => {
		expect(main).toContain("revealWhenReady(mainWindow,");
	});

	it("has no unbounded wait of its own left behind", () => {
		// A second `ready-to-show` handler that shows the window would restore the
		// silent hang for whichever of the two the paint never reaches.
		expect(main).not.toContain('mainWindow.once("ready-to-show"');
	});
});
