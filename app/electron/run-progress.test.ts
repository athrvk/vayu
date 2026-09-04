/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The taskbar and Dock progress indicator (#1362).
 *
 * Every case names its platform rather than reading the host's: the whole point
 * of this module is that the three platforms differ, and a test that asserted
 * the runner's own would exercise one branch on Linux CI and a different one on
 * a developer's Mac.
 */

import { describe, it, expect, vi } from "vitest";
import {
	createRunProgress,
	parseRunProgressUpdate,
	registerRunProgressIpc,
	RUN_PROGRESS_CHANNEL,
	RUN_PROGRESS_ERROR_FLASH_MS,
	type RunProgressPainter,
} from "./run-progress";
import type { IpcEventLike } from "./renderer-watch";

type Call = [number, { mode: string }?];

function harness(platform: NodeJS.Platform, options: { window?: boolean } = {}) {
	const calls: Call[] = [];
	const timers: Array<{ ms: number; fn: () => void }> = [];
	const window = {
		setProgressBar(progress: number, opts?: { mode: string }) {
			calls.push(opts ? [progress, opts] : [progress]);
		},
	};
	const painter = createRunProgress({
		window: () => (options.window === false ? null : window),
		platform,
		after: (ms, fn) => {
			timers.push({ ms, fn });
		},
	});
	return {
		painter,
		calls,
		/** Run the one pending timer, the way the flash's two seconds would. */
		fireTimers(): void {
			const pending = timers.splice(0, timers.length);
			for (const timer of pending) timer.fn();
		},
		timers,
	};
}

describe("createRunProgress - what each platform paints", () => {
	it("paints the fraction on Windows and macOS", () => {
		for (const platform of ["win32", "darwin"] as const) {
			const { painter, calls } = harness(platform);
			painter.apply({ state: "running", value: 0.42 });
			expect(calls, platform).toEqual([[0.42]]);
		}
	});

	it("paints nothing at all on Linux, where Electron 44 dropped the surface", () => {
		const { painter, calls } = harness("linux");
		painter.apply({ state: "running", value: 0.42 });
		painter.apply({ state: "running", value: null });
		painter.apply({ state: "failed" });
		painter.apply({ state: "idle" });
		painter.clear();
		expect(calls).toEqual([]);
	});

	it("clamps a fraction outside 0..1, and a value that is not a number", () => {
		const { painter, calls } = harness("win32");
		painter.apply({ state: "running", value: 1.4 });
		painter.apply({ state: "running", value: -0.2 });
		painter.apply({ state: "running", value: Number.NaN });
		expect(calls).toEqual([[1], [0], [0]]);
	});

	it("shows indeterminate on Windows for a run with no denominator", () => {
		const { painter, calls } = harness("win32");
		painter.apply({ state: "running", value: null });
		expect(calls).toEqual([[2, { mode: "indeterminate" }]]);
	});

	it("clears on macOS for a run with no denominator, rather than freezing the last bar", () => {
		const { painter, calls } = harness("darwin");
		painter.apply({ state: "running", value: 0.5 });
		painter.apply({ state: "running", value: null });
		expect(calls).toEqual([[0.5], [-1]]);
	});

	it("clears on idle", () => {
		for (const platform of ["win32", "darwin"] as const) {
			const { painter, calls } = harness(platform);
			painter.apply({ state: "running", value: 0.5 });
			painter.apply({ state: "idle" });
			expect(calls[calls.length - 1], platform).toEqual([-1]);
		}
	});

	it("survives having no window", () => {
		const { painter, calls } = harness("win32", { window: false });
		expect(() => painter.apply({ state: "running", value: 0.5 })).not.toThrow();
		expect(calls).toEqual([]);
	});
});

describe("createRunProgress - a run that failed", () => {
	it("flashes the error state on Windows, then clears it", () => {
		const { painter, calls, timers, fireTimers } = harness("win32");
		painter.apply({ state: "failed" });
		expect(calls).toEqual([[1, { mode: "error" }]]);
		expect(timers[0].ms).toBe(RUN_PROGRESS_ERROR_FLASH_MS);
		fireTimers();
		expect(calls).toEqual([[1, { mode: "error" }], [-1]]);
	});

	it("clears immediately on macOS, which has no error state", () => {
		const { painter, calls, timers } = harness("darwin");
		painter.apply({ state: "failed" });
		expect(calls).toEqual([[-1]]);
		expect(timers).toEqual([]);
	});

	/*
	 * Mutation check: drop the generation guard in `paintFailed` and the flash's
	 * own clear fires here, wiping the bar of a run that is still going.
	 */
	it("does not wipe a bar painted after it, when the flash comes due", () => {
		const { painter, calls, fireTimers } = harness("win32");
		painter.apply({ state: "failed" });
		painter.apply({ state: "running", value: 0.6 });
		fireTimers();
		expect(calls).toEqual([[1, { mode: "error" }], [0.6]]);
	});
});

describe("parseRunProgressUpdate", () => {
	it("reads the three shapes the renderer sends", () => {
		expect(parseRunProgressUpdate({ state: "running", value: 0.5 })).toEqual({
			state: "running",
			value: 0.5,
		});
		expect(parseRunProgressUpdate({ state: "running", value: null })).toEqual({
			state: "running",
			value: null,
		});
		expect(parseRunProgressUpdate({ state: "failed" })).toEqual({ state: "failed" });
		expect(parseRunProgressUpdate({ state: "idle" })).toEqual({ state: "idle" });
	});

	it("refuses anything else", () => {
		for (const raw of [
			null,
			undefined,
			"running",
			42,
			{},
			{ state: "spinning" },
			{ state: "running", value: "0.5" },
			{ state: "running", value: Number.NaN },
		]) {
			expect(parseRunProgressUpdate(raw), JSON.stringify(raw) ?? "undefined").toBeNull();
		}
	});
});

describe("registerRunProgressIpc", () => {
	function ipcHarness() {
		const applied: unknown[] = [];
		let cleared = 0;
		const painter: RunProgressPainter = {
			apply: (update) => {
				applied.push(update);
			},
			clear: () => {
				cleared++;
			},
		};
		let listener: ((event: IpcEventLike, ...args: unknown[]) => void) | null = null;
		const ipc = {
			on(channel: string, fn: (event: IpcEventLike, ...args: unknown[]) => void) {
				expect(channel).toBe(RUN_PROGRESS_CHANNEL);
				listener = fn;
			},
		};
		registerRunProgressIpc(ipc, painter);
		const senderEvents = new Map<string, () => void>();
		const sender = {
			id: 1,
			once: (event: "destroyed", fn: () => void) => senderEvents.set(event, fn),
			on: (event: "did-start-loading", fn: () => void) => senderEvents.set(event, fn),
		};
		return {
			applied,
			cleared: () => cleared,
			send: (payload: unknown) => listener?.({ sender }, payload),
			fire: (event: "destroyed" | "did-start-loading") => senderEvents.get(event)?.(),
		};
	}

	it("applies an update the renderer sends", () => {
		const ipc = ipcHarness();
		ipc.send({ state: "running", value: 0.25 });
		expect(ipc.applied).toEqual([{ state: "running", value: 0.25 }]);
	});

	it("ignores a message that is not an update, and says so", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ipc = ipcHarness();
		ipc.send({ state: "elsewhere" });
		expect(ipc.applied).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	/*
	 * Mutation check: drop the `once("destroyed")` watch and a renderer that
	 * crashes mid-run leaves its bar on the taskbar for the rest of the session.
	 */
	it("clears when the renderer goes away or reloads", () => {
		for (const event of ["destroyed", "did-start-loading"] as const) {
			const ipc = ipcHarness();
			ipc.send({ state: "running", value: 0.25 });
			expect(ipc.cleared()).toBe(0);
			ipc.fire(event);
			expect(ipc.cleared(), event).toBe(1);
		}
	});
});
