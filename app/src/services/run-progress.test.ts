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

	it("says failed when the run fails", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.5);
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun);
		expect(send).toHaveBeenLastCalledWith({ state: "failed" });
	});

	it("sends nothing for a run the indicator is not showing", () => {
		const send = stubBridge();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun);
		runProgress.fail(RUN_PROGRESS_KEYS.collectionRun);
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
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		expect(send).toHaveBeenLastCalledWith({ state: "running", value: null });
	});

	/*
	 * Mutation check: drop the `shownFor` guard in `clear` and the superseded
	 * load run's stop - the dashboard calls `stopMonitoring` for a run it finds
	 * already finished - wipes the bar of the collection run that is streaming.
	 */
	it("ignores a superseded run's stop", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		send.mockClear();
		runProgress.clear(RUN_PROGRESS_KEYS.loadRun);
		expect(send).not.toHaveBeenCalled();
	});

	/* Same guard, the other terminal path. */
	it("ignores a superseded run's failure", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		send.mockClear();
		runProgress.fail(RUN_PROGRESS_KEYS.loadRun);
		expect(send).not.toHaveBeenCalled();
	});

	/*
	 * And the superseded run leaves nothing behind: when the run that took over
	 * ends, the indicator goes away rather than falling back to a fraction from
	 * a run nothing is watching any more.
	 */
	it("leaves no bar behind when the run that took over ends", () => {
		const send = stubBridge();
		runProgress.report(RUN_PROGRESS_KEYS.loadRun, 0.2);
		runProgress.report(RUN_PROGRESS_KEYS.collectionRun, null);
		runProgress.clear(RUN_PROGRESS_KEYS.collectionRun);
		expect(send).toHaveBeenLastCalledWith({ state: "idle" });
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
