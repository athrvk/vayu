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
 * The suspend/resume pair turning into one sleep record (issue #1357). The
 * whole design is that the anchor is taken on the way down, at suspend time -
 * so the case that matters most here proves that, by moving the dashboard's
 * elapsed time between the two events and checking the recorded sleep still
 * carries the suspend-time value.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostSleepRecorder } from "./useHostSleepRecorder";
import { useDashboardStore } from "@/stores";
import { useHostSleepStore } from "@/stores/host-sleep-store";
import type { LoadTestMetrics } from "@/types";

type SuspendCb = (event: { at: number }) => void;
type ResumeCb = (event: { at: number; durationMs: number }) => void;

function tick(elapsed: number): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 0,
		latency_p95_ms: 0,
		latency_p99_ms: 0,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
	};
}

let suspendCb: SuspendCb | null;
let resumeCb: ResumeCb | null;
let unsubSuspend: ReturnType<typeof vi.fn>;
let unsubResume: ReturnType<typeof vi.fn>;

function stubElectronAPI() {
	unsubSuspend = vi.fn();
	unsubResume = vi.fn();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onHostSuspended: (cb: SuspendCb) => {
			suspendCb = cb;
			return unsubSuspend;
		},
		onHostResumed: (cb: ResumeCb) => {
			resumeCb = cb;
			return unsubResume;
		},
	};
}

beforeEach(() => {
	suspendCb = null;
	resumeCb = null;
	stubElectronAPI();
	useHostSleepStore.setState({ byRun: {}, runOrder: [] });
	useDashboardStore.setState({ currentRunId: null, isStreaming: false, currentMetrics: null });
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	vi.restoreAllMocks();
});

describe("useHostSleepRecorder", () => {
	it("records one sleep against the streaming run, anchored at the suspend", () => {
		useDashboardStore.setState({
			currentRunId: "run_1",
			isStreaming: true,
			currentMetrics: tick(42),
		});
		renderHook(() => useHostSleepRecorder());
		expect(suspendCb).not.toBeNull();

		act(() => suspendCb!({ at: 1000 }));

		// The clock keeps moving on the renderer's side of the suspend (the
		// frozen stretch is only real for the OS, not for this state) - if the
		// anchor were read again at resume instead of carried from the suspend,
		// startSeconds would come out 999 here, not 42.
		useDashboardStore.setState({ currentMetrics: tick(999) });

		act(() => resumeCb!({ at: 5000, durationMs: 4000 }));

		const sleeps = useHostSleepStore.getState().byRun.run_1;
		expect(sleeps).toEqual([{ at: 5000 - 4000, durationMs: 4000, startSeconds: 42 }]);
	});

	it("records nothing on a resume when no run has an id", () => {
		useDashboardStore.setState({
			currentRunId: null,
			isStreaming: true,
			currentMetrics: tick(5),
		});
		renderHook(() => useHostSleepRecorder());

		act(() => suspendCb!({ at: 1000 }));
		act(() => resumeCb!({ at: 5000, durationMs: 4000 }));

		expect(useHostSleepStore.getState().runOrder).toEqual([]);
	});

	it("records nothing on a resume when the run is not streaming", () => {
		useDashboardStore.setState({
			currentRunId: "run_1",
			isStreaming: false,
			currentMetrics: tick(5),
		});
		renderHook(() => useHostSleepRecorder());

		act(() => suspendCb!({ at: 1000 }));
		act(() => resumeCb!({ at: 5000, durationMs: 4000 }));

		expect(useHostSleepStore.getState().runOrder).toEqual([]);
	});

	it("records nothing on a resume with no preceding suspend", () => {
		useDashboardStore.setState({
			currentRunId: "run_1",
			isStreaming: true,
			currentMetrics: tick(5),
		});
		renderHook(() => useHostSleepRecorder());

		act(() => resumeCb!({ at: 5000, durationMs: 4000 }));

		expect(useHostSleepStore.getState().runOrder).toEqual([]);
	});

	it("unsubscribes both listeners on unmount", () => {
		const { unmount } = renderHook(() => useHostSleepRecorder());
		unmount();

		expect(unsubSuspend).toHaveBeenCalledTimes(1);
		expect(unsubResume).toHaveBeenCalledTimes(1);
	});

	it("is inert without window.electronAPI", () => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		expect(() => {
			const { unmount } = renderHook(() => useHostSleepRecorder());
			unmount();
		}).not.toThrow();
	});
});
