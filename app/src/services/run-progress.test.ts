/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the taskbar and Dock indicator (#1362). What each
 * platform paints is `electron/run-progress.ts`'s question; this side answers
 * which run is being painted, and what its fraction is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProgress, RUN_PROGRESS_KEYS } from "./run-progress";
import type { RunProgressUpdate } from "@/types/electron";

function stubBridge() {
	const setRunProgress = vi.fn<(update: RunProgressUpdate) => void>();
	vi.stubGlobal("window", { electronAPI: { setRunProgress } });
	return setRunProgress;
}

/**
 * The reporter's state is a module singleton, as the one indicator it speaks
 * for is. Each case starts from nothing live and nothing remembered as painted,
 * driven through the same calls a run makes rather than through a back door.
 */
beforeEach(() => {
	stubBridge();
	for (const key of Object.values(RUN_PROGRESS_KEYS)) {
		runProgress.report(key, null);
		runProgress.clear(key);
	}
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("runProgress - one run", () => {
	it("sends the fraction a run reports", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.25);
		expect(send).toHaveBeenCalledWith({ state: "running", value: 0.25 });
	});

	it("sends null for a run with no denominator", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		expect(send).toHaveBeenCalledWith({ state: "running", value: null });
	});

	/*
	 * Mutation check: drop the `lastRunningSent` comparison and this sends three
	 * messages, one per flush, for a bar that has not moved.
	 */
	it("does not re-send a fraction that has not moved", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5);
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5);
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.75);
		expect(send.mock.calls.map(([update]) => update)).toEqual([
			{ state: "running", value: 0.5 },
			{ state: "running", value: 0.75 },
		]);
	});

	it("goes idle when the run ends", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5);
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun);
		expect(send).toHaveBeenLastCalledWith({ state: "idle" });
	});

	it("says failed when the only run fails", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5);
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun);
		expect(send).toHaveBeenLastCalledWith({ state: "failed" });
	});

	it("sends nothing for a run that was never live", () => {
		const send = stubBridge();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun);
		runProgress.fail(RUN_PROGRESS_KEYS.collectionRun);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("runProgress - two runs and one indicator", () => {
	it("gives the indicator to the run that started most recently", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: null });
	});

	it("records the run behind without painting it", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.4);
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * Mutation check: paint from a single "current" value instead of the keyed
	 * map and the load run's bar never comes back - the taskbar sits idle while
	 * a run is still going.
	 */
	it("hands it back to the run still going, at that run's own progress", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.4);
		runProgress.clear(RUN_PROGRESS_KEYS.collectionRun);
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: 0.4 });
	});

	it("shows the run still going rather than the other's failure", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.4);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		runProgress.fail(RUN_PROGRESS_KEYS.collectionRun);
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: 0.4 });
		expect(send.mock.calls.some(([update]) => update.state === "failed")).toBe(false);
	});

	it("keeps the indicator when the run behind ends", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		send.mockClear();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("runProgress - outside Electron", () => {
	it("does nothing without the bridge", () => {
		vi.stubGlobal("window", {});
		expect(() => runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5)).not.toThrow();
	});

	it("logs a send that throws rather than raising it at the run", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("window", {
			electronAPI: {
				setRunProgress: () => {
					throw new Error("bridge is gone");
				},
			},
		});
		expect(() => runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5)).not.toThrow();
		expect(warn).toHaveBeenCalled();
	});
});
