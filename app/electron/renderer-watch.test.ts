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
import { createRendererWatch, type RendererLike } from "./renderer-watch";

function fakeSender(id: number) {
	const listeners = new Map<string, Array<() => void>>();
	const add = (event: string, listener: () => void) => {
		const existing = listeners.get(event) ?? [];
		existing.push(listener);
		listeners.set(event, existing);
	};
	const sender: RendererLike = {
		id,
		once: (event, listener) => add(event, listener),
		on: (event, listener) => add(event, listener),
	};
	return {
		sender,
		count: (event: string) => (listeners.get(event) ?? []).length,
		fire: (event: string) => {
			for (const listener of listeners.get(event) ?? []) listener();
		},
	};
}

describe("createRendererWatch", () => {
	it("reports a renderer that was destroyed, and one that reloaded", () => {
		for (const event of ["destroyed", "did-start-loading"] as const) {
			const gone = vi.fn();
			const renderer = fakeSender(7);
			createRendererWatch(gone)(renderer.sender);
			renderer.fire(event);
			expect(gone, event).toHaveBeenCalledWith(7);
		}
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
		expect(renderer.count("did-start-loading")).toBe(1);
	});

	it("watches each renderer separately", () => {
		const gone = vi.fn();
		const watch = createRendererWatch(gone);
		const first = fakeSender(1);
		const second = fakeSender(2);
		watch(first.sender);
		watch(second.sender);
		second.fire("destroyed");
		expect(gone).toHaveBeenCalledTimes(1);
		expect(gone).toHaveBeenCalledWith(2);
	});

	it("watches a renderer again once it has been destroyed", () => {
		const gone = vi.fn();
		const watch = createRendererWatch(gone);
		const first = fakeSender(3);
		watch(first.sender);
		first.fire("destroyed");
		// A destroyed id can come back - `webContents` ids are not reused within a
		// session, but a caller re-watching is not a bug and must still subscribe.
		const reborn = fakeSender(3);
		watch(reborn.sender);
		expect(reborn.count("destroyed")).toBe(1);
	});
});
