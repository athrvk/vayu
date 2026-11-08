/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one copy of "this renderer is gone", shared by the wake lock (#1357) and
 * the taskbar progress bar (#1362). Each caller's own suite proves it acts on
 * the callback; this file proves the subscription itself.
 */

import { describe, it, expect, vi } from "vitest";
import { createRendererWatch, type NavigationDetails, type RendererLike } from "./renderer-watch";

function fakeSender(id: number) {
	const destroyedListeners: Array<() => void> = [];
	const navigationListeners: Array<(details: NavigationDetails) => void> = [];
	const sender: RendererLike = {
		id,
		once: (_event, listener) => destroyedListeners.push(listener),
		on: (_event, listener) => navigationListeners.push(listener),
	};
	return {
		sender,
		count: (event: "destroyed" | "did-start-navigation") =>
			(event === "destroyed" ? destroyedListeners : navigationListeners).length,
		destroy: () => {
			for (const listener of destroyedListeners) listener();
		},
		navigate: (details: NavigationDetails) => {
			for (const listener of navigationListeners) listener(details);
		},
	};
}

describe("createRendererWatch", () => {
	it("reports a renderer that was destroyed", () => {
		const gone = vi.fn();
		const renderer = fakeSender(7);
		createRendererWatch(gone)(renderer.sender);
		renderer.destroy();
		expect(gone).toHaveBeenCalledWith(7);
	});

	it("reports a renderer whose main frame loads a new document", () => {
		const gone = vi.fn();
		const renderer = fakeSender(7);
		createRendererWatch(gone)(renderer.sender);
		renderer.navigate({ isMainFrame: true, isSameDocument: false });
		expect(gone).toHaveBeenCalledWith(7);
	});

	/*
	 * #3377: the response viewer's HTML preview is an iframe, and its load must
	 * not release a running load test's wake lock or clear the taskbar progress.
	 * Mutation check: call `gone` unconditionally and the first row reddens;
	 * drop `isSameDocument` from the predicate and the second does.
	 */
	it.each([
		["a subframe navigation", { isMainFrame: false, isSameDocument: false }],
		["a same-document navigation", { isMainFrame: true, isSameDocument: true }],
	])("does not report %s", (_name, details) => {
		const gone = vi.fn();
		const renderer = fakeSender(7);
		createRendererWatch(gone)(renderer.sender);
		renderer.navigate(details);
		expect(gone).not.toHaveBeenCalled();
	});

	/*
	 * Mutation check: drop the `watched` set and a caller that watches on every
	 * message subscribes once per message, so one reload calls back hundreds of
	 * times - and a run reporting progress twice a second is exactly such a caller.
	 */
	it("subscribes once however often a renderer is watched", () => {
		const gone = vi.fn();
		const renderer = fakeSender(7);
		const watch = createRendererWatch(gone);
		watch(renderer.sender);
		watch(renderer.sender);
		watch(renderer.sender);
		expect(renderer.count("destroyed")).toBe(1);
		expect(renderer.count("did-start-navigation")).toBe(1);
	});

	it("watches each renderer separately", () => {
		const gone = vi.fn();
		const watch = createRendererWatch(gone);
		const first = fakeSender(1);
		const second = fakeSender(2);
		watch(first.sender);
		watch(second.sender);
		second.destroy();
		expect(gone).toHaveBeenCalledTimes(1);
		expect(gone).toHaveBeenCalledWith(2);
	});

	it("watches a renderer again once it has been destroyed", () => {
		const gone = vi.fn();
		const watch = createRendererWatch(gone);
		const first = fakeSender(3);
		watch(first.sender);
		first.destroy();
		// A destroyed id can come back - `webContents` ids are not reused within a
		// session, but a caller re-watching is not a bug and must still subscribe.
		const reborn = fakeSender(3);
		watch(reborn.sender);
		expect(reborn.count("destroyed")).toBe(1);
	});
});
