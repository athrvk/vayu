/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Alt on its own opens the application menu; Alt as a modifier must not (#1361).
 *
 * The second half is the one that breaks a user's day: Alt+Tab away and back,
 * or Alt+← to go back, and a menu that opened on every one of those would be a
 * menu opening while they typed.
 */

import { describe, it, expect, vi } from "vitest";
import { createAltTapWatcher } from "./alt-tap";

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
	key,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...modifiers,
});

describe("createAltTapWatcher", () => {
	it("taps when Alt is pressed and released alone", () => {
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));
		watcher.keyup(key("Alt"));

		expect(onTap).toHaveBeenCalledTimes(1);
	});

	it("does not tap on the press alone", () => {
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));

		expect(onTap).not.toHaveBeenCalled();
	});

	it("does not tap when a key was pressed while Alt was held", () => {
		// Alt+← is Go back on this platform, and Alt+Tab leaves the window.
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));
		watcher.keydown(key("ArrowLeft", { altKey: true } as Partial<KeyboardEvent>));
		watcher.keyup(key("ArrowLeft"));
		watcher.keyup(key("Alt"));

		expect(onTap).not.toHaveBeenCalled();
	});

	it("does not tap for Alt carrying another modifier, or for AltGr", () => {
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		for (const press of [
			key("Alt", { ctrlKey: true }),
			key("Alt", { metaKey: true }),
			key("Alt", { shiftKey: true }),
			key("AltGraph"),
		]) {
			watcher.keydown(press);
			watcher.keyup(key("Alt"));
		}

		expect(onTap).not.toHaveBeenCalled();
	});

	it("does not tap when the release is some other key", () => {
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));
		watcher.keyup(key("Tab"));
		watcher.keyup(key("Alt"));

		expect(onTap).not.toHaveBeenCalled();
	});

	it("forgets a press that focus left mid-hold", () => {
		// Alt+Tab: the window is blurred before the release ever arrives, and the
		// release that lands when the user comes back is not a menu request.
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));
		watcher.cancel();
		watcher.keyup(key("Alt"));

		expect(onTap).not.toHaveBeenCalled();
	});

	it("taps again on the next press", () => {
		const onTap = vi.fn();
		const watcher = createAltTapWatcher(onTap);

		watcher.keydown(key("Alt"));
		watcher.keyup(key("Alt"));
		watcher.keydown(key("Alt"));
		watcher.keyup(key("Alt"));

		expect(onTap).toHaveBeenCalledTimes(2);
	});
});
