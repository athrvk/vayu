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
 * for is. Each case starts from nothing shown and nothing remembered as
 * painted, driven through the same calls a run makes rather than a back door.
 */
beforeEach(() => {
	stubBridge();
	for (const key of Object.values(RUN_PROGRESS_KEYS)) {
		runProgress.claim(key, "run_reset");
		runProgress.clear(key, "run_reset");
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
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.25);
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: 0.25 });
	});

	it("starts a claimed run with no fraction", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_1");
		expect(send).toHaveBeenCalledWith({ state: "running", value: null });
	});

	/*
	 * Mutation check: drop the `lastRunningSent` comparison and this sends three
	 * messages, one per flush, for a bar that has not moved.
	 */
	it("does not re-send a fraction that has not moved", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.5);
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.5);
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.75);
		expect(send.mock.calls.map(([update]) => update)).toEqual([
			{ state: "running", value: 0.5 },
			{ state: "running", value: 0.75 },
		]);
	});

	it("goes idle when the run ends", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, "run_1");
		expect(send).toHaveBeenLastCalledWith({ state: "idle" });
	});

	it("says failed when the run fails", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun, "run_1");
		expect(send).toHaveBeenLastCalledWith({ state: "failed" });
	});

	/*
	 * The flash outlives the run that raised it: `fail` gives the claim up, so
	 * the failed run's own last flush - a batcher's trailing commit lands after
	 * the error - cannot repaint the bar as running.
	 */
	it("does not repaint a failed run as running", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun, "run_1");
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.9);
		expect(send).not.toHaveBeenCalled();
	});

	it("sends nothing for a run the indicator is not showing", () => {
		const send = stubBridge();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.fail(RUN_PROGRESS_KEYS.collectionRun, "run_1");
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * A service whose run has already been forgotten - `handleClose` nulls its
	 * `activeRunId` before the terminal path finishes - names no run, and a call
	 * that names no run holds no claim.
	 */
	it("sends nothing for a call that cannot name its run", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, null, 0.5);
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, null);
		expect(send).not.toHaveBeenCalled();
	});
});

/*
 * `sse-client.ts` is one `EventSource` for both run types, so a second
 * `startMonitoring` closes the first run's stream where it stands: that run
 * keeps going on the engine and the renderer never sees another tick of it, nor
 * runs its terminal handlers. The indicator follows the run being watched.
 */
describe("runProgress - a run that supersedes another", () => {
	it("hands the indicator to the run the renderer is now watching", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.2);
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_2");
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: null });
	});

	/*
	 * Mutation check: drop the `isShown` guard in `clear` and the superseded
	 * load run's stop - the dashboard calls `stopMonitoring` for a run it finds
	 * already finished - wipes the bar of the collection run that is streaming.
	 */
	it("ignores a superseded run's stop", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_2");
		send.mockClear();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, "run_1");
		expect(send).not.toHaveBeenCalled();
	});

	/* Same guard, the other terminal path. */
	it("ignores a superseded run's failure", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_2");
		send.mockClear();
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun, "run_1");
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * And the third path, which is what #1405 is about: a superseded run can
	 * still *report*. Its steps or ticks are batched on a trailing timer, so one
	 * commit fires after the run that took over has painted its own bar.
	 *
	 * Mutation check: drop the guard in `report` and the last line repaints the
	 * collection run's fresh bar with a fraction from a run nobody is watching,
	 * where it stays until the live run's next flush takes it back.
	 */
	it("ignores a superseded run's last buffered report", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_1");
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_2");
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_2", 0.1);
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, "run_1", 0.8);
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * And the case a key-shaped claim could not see at all: two runs of the same
	 * kind. Nothing in the UI prevents starting a second load test, and to a
	 * guard that compares `load-run` with `load-run` the superseded run is still
	 * the one being shown.
	 */
	it("ignores a run superseded by another of its own kind", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_2");
		send.mockClear();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.4);
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun, "run_1");
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * And the superseded run leaves nothing behind: when the run that took over
	 * ends, the indicator goes away rather than falling back to a fraction from
	 * a run nothing is watching any more.
	 */
	it("leaves no bar behind when the run that took over ends", () => {
		const send = stubBridge();
		runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1");
		runProgress.claim(RUN_PROGRESS_KEYS.collectionRun, "run_2");
		runProgress.clear(RUN_PROGRESS_KEYS.collectionRun, "run_2");
		expect(send).toHaveBeenLastCalledWith({ state: "idle" });
	});
});

describe("runProgress - outside Electron", () => {
	it("does nothing without the bridge", () => {
		vi.stubGlobal("window", {});
		expect(() => runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1")).not.toThrow();
		expect(() => runProgress.report(RUN_PROGRESS_KEYS.loadRun, "run_1", 0.5)).not.toThrow();
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
		expect(() => runProgress.claim(RUN_PROGRESS_KEYS.loadRun, "run_1")).not.toThrow();
		expect(warn).toHaveBeenCalled();
	});
});
