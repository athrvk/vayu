/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `UPlotChart`'s ResizeObserver (#1717): a resize delivery must not call
 * `setSize` synchronously inside the observer callback - that is the same
 * shape as the loop #1713 fixed (a delivery that resizes the element the
 * observer itself watches), which triggers the browser's "ResizeObserver
 * loop completed with undelivered notifications". Deferred to the next
 * frame instead, same pattern as useResolvedResponsePosition.
 *
 * jsdom has no real ResizeObserver or rAF scheduling, so both are recording
 * stubs the test drives by hand - the same pattern
 * RequestBuilderLayout.response-position.test.tsx uses for the analogous
 * hook.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";

// `setSize` is assigned per-instance inside uPlot's own constructor (a
// closure over its instance state), not on its prototype, so it can't be
// `vi.spyOn(uPlot.prototype, ...)`'d - the constructed instances are captured
// here instead, and `setSize` spied on directly on the instance.
const instances = vi.hoisted(() => ({ all: [] as uPlot[] }));
vi.mock("uplot", async (importOriginal) => {
	// `uplot`'s types declare `export = uPlot` (no `.default` in the type), but
	// the esm build vite/vitest resolve does carry one at runtime - hence the
	// cast rather than a typed `importOriginal<typeof import("uplot")>()`.
	const actual = (await importOriginal()) as { default: new (...args: unknown[]) => uPlot };
	const RealUPlot = actual.default;
	class TrackedUPlot extends RealUPlot {
		constructor(...args: unknown[]) {
			super(...args);
			instances.all.push(this as unknown as uPlot);
		}
	}
	return { ...actual, default: TrackedUPlot };
});

const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

class RecordingResizeObserver {
	private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
	constructor(callback: ResizeObserverCallback) {
		this.entry = { callback, targets: [] };
		observers.push(this.entry);
	}
	observe(target: Element) {
		this.entry.targets.push(target);
	}
	unobserve() {}
	disconnect() {}
}

const frames: FrameRequestCallback[] = [];
const flushFrames = () => {
	const pending = frames.splice(0);
	pending.forEach((frame) => frame(performance.now()));
};

const data: uPlot.AlignedData = [
	[0, 1, 2, 3],
	[10, 12, 11, 14],
];
const series: UPlotSeriesSpec[] = [{ label: "rps", role: "categorical" }];

beforeEach(() => {
	observers.length = 0;
	frames.length = 0;
	instances.all.length = 0;
	vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
	vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
		frames.push(frame);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => {
		frames.splice(id - 1, 1);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("UPlotChart - deferred ResizeObserver setSize (#1717)", () => {
	it("does not call setSize synchronously from a resize delivery; calls it after the next frame", () => {
		render(<UPlotChart data={data} series={series} />);

		expect(observers).toHaveLength(1);
		expect(instances.all).toHaveLength(1);
		const setSize = vi.spyOn(instances.all[0], "setSize");
		const observer = observers[0];

		act(() => {
			observer.callback([], {} as ResizeObserver);
		});
		expect(setSize).not.toHaveBeenCalled();

		act(() => {
			flushFrames();
		});
		expect(setSize).toHaveBeenCalledTimes(1);
	});

	it("coalesces several deliveries inside one frame into a single setSize call", () => {
		render(<UPlotChart data={data} series={series} />);
		const setSize = vi.spyOn(instances.all[0], "setSize");
		const observer = observers[0];

		act(() => {
			observer.callback([], {} as ResizeObserver);
			observer.callback([], {} as ResizeObserver);
			observer.callback([], {} as ResizeObserver);
		});
		expect(setSize).not.toHaveBeenCalled();

		act(() => {
			flushFrames();
		});
		expect(setSize).toHaveBeenCalledTimes(1);
	});
});
