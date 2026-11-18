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
 * The close that stops a live run has to be able to name it (#3604), and main
 * hears of the run only from this publisher. One that never fired leaves the
 * X button stopping a 30 minute test with no question; one that kept a dead
 * engine's run would ask about a run that is already over.
 *
 * Mutation check: drop `serving &&` from the publisher and the not-serving case
 * reddens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDashboardStore, useEngineStore, useScenarioRunStore } from "@/stores";
import { useLiveRunPublisher } from "./useLiveRunPublisher";

function stubBridge() {
	const setLiveRun = vi.fn();
	Object.defineProperty(window, "electronAPI", {
		value: { setLiveRun },
		configurable: true,
		writable: true,
	});
	return setLiveRun;
}

function startLoadRun() {
	useDashboardStore.setState({
		currentRunId: "run_1",
		phase: { phase: "streaming" },
		requestInfo: { method: "GET", url: "https://api.example.com/orders" },
	});
}

beforeEach(() => {
	useEngineStore.setState({ engineStatus: "connected", engineError: null, engineCrash: null });
	useDashboardStore.setState({ currentRunId: null, phase: { phase: "idle" }, requestInfo: null });
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
});

afterEach(() => {
	Reflect.deleteProperty(window, "electronAPI");
});

describe("useLiveRunPublisher", () => {
	it("publishes a load test as it starts, by what it is aimed at", () => {
		const setLiveRun = stubBridge();
		renderHook(() => useLiveRunPublisher());
		expect(setLiveRun).toHaveBeenLastCalledWith(null);

		act(startLoadRun);

		expect(setLiveRun).toHaveBeenLastCalledWith({
			kind: "load",
			label: "GET https://api.example.com/orders",
		});
	});

	it("publishes a streaming collection run", () => {
		const setLiveRun = stubBridge();
		renderHook(() => useLiveRunPublisher());

		act(() => useScenarioRunStore.setState({ runId: "run_2", isStreaming: true }));

		expect(setLiveRun).toHaveBeenLastCalledWith({ kind: "collection", label: null });
	});

	it("withdraws the run once it ends", () => {
		const setLiveRun = stubBridge();
		startLoadRun();
		renderHook(() => useLiveRunPublisher());
		expect(setLiveRun).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));

		act(() =>
			useDashboardStore.setState({ phase: { phase: "awaitingReport", stopped: true } })
		);

		expect(setLiveRun).toHaveBeenLastCalledWith(null);
	});

	it("says nothing new when the run moves between live phases", () => {
		const setLiveRun = stubBridge();
		startLoadRun();
		renderHook(() => useLiveRunPublisher());
		const sent = setLiveRun.mock.calls.length;

		act(() =>
			useDashboardStore.setState({ phase: { phase: "streamLost", message: "dropped" } })
		);

		expect(setLiveRun).toHaveBeenCalledTimes(sent);
	});

	it.each(["unreachable", "starting"] as const)(
		"publishes no run while the engine is %s, whatever the stores still hold",
		(engineStatus) => {
			const setLiveRun = stubBridge();
			startLoadRun();
			renderHook(() => useLiveRunPublisher());
			expect(setLiveRun).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));

			act(() => useEngineStore.setState({ engineStatus }));

			expect(setLiveRun).toHaveBeenLastCalledWith(null);
		}
	);

	it("does nothing outside Electron, where there is no bridge", () => {
		startLoadRun();

		const { result } = renderHook(() => useLiveRunPublisher());

		expect(result.current).toBeUndefined();
	});
});
