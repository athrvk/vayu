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
 * A run an MCP agent started is watched by the app from the moment it starts
 * (#1419).
 *
 * What is under test is the routing: which service is entered for which kind of
 * run, and that a `run` event which is not a start enters neither. What each
 * service then does - the wake lock, the progress claim, the terminal
 * notification - is its own file's tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRunWatchers } from "./useRunWatchers";
import { loadTestService } from "@/services/load-test-service";
import { scenarioRunService } from "@/services/scenario-run-service";
import { useDashboardStore } from "@/stores/dashboard-store";
import type { McpDataChangedEvent } from "@/types/domain";

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * Put a partial preload bridge on the window, or take it away with `null`.
 *
 * Assigned onto the real `window` rather than stubbed over it, and through
 * `unknown` because `Window.electronAPI` is declared as the whole `ElectronAPI`
 * while this case needs one method of it.
 */
function bridged(api: Partial<Bridge> | null): void {
	const host = window as unknown as { electronAPI?: Partial<Bridge> };
	if (api === null) delete host.electronAPI;
	else host.electronAPI = api;
}

/** Mount the hook and hand back the emitter main would call. */
function mounted(): {
	emit: (event: McpDataChangedEvent) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
	unmount: () => void;
} {
	let emit: ((event: McpDataChangedEvent) => void) | null = null;
	const unsubscribe = vi.fn();
	bridged({
		onMcpDataChanged: (callback: (event: McpDataChangedEvent) => void) => {
			emit = callback;
			return unsubscribe;
		},
	});
	const { unmount } = renderHook(() => useRunWatchers());
	if (!emit) throw new Error("the hook subscribed to nothing");
	return { emit, unsubscribe, unmount };
}

afterEach(() => {
	useDashboardStore.setState({ currentRunId: null, mode: "running" });
	bridged(null);
	vi.restoreAllMocks();
});

describe("useRunWatchers", () => {
	it("watches a load run an agent started, with the store pointed at it first", () => {
		const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
		const scenario = vi
			.spyOn(scenarioRunService, "startMonitoring")
			.mockImplementation(() => {});
		const { emit } = mounted();

		emit({ entity: "run", startedRun: { runId: "run_7", kind: "load" } });

		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith("run_7");
		expect(scenario).not.toHaveBeenCalled();
		// The service states that its caller registers the run: without this the
		// dashboard opened later finds no current run and the ticks that arrived
		// while it was closed belong to nothing.
		expect(useDashboardStore.getState().currentRunId).toBe("run_7");
		expect(useDashboardStore.getState().mode).toBe("running");
	});

	it("watches a collection run through the scenario service", () => {
		// Mutation check: drop the kind branch and this case attaches the load
		// service to a stream that publishes steps and no metric ticks - a
		// permanently empty view rather than a degraded one.
		const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
		const scenario = vi
			.spyOn(scenarioRunService, "startMonitoring")
			.mockImplementation(() => {});
		const { emit } = mounted();

		emit({ entity: "run", startedRun: { runId: "run_8", kind: "collection" } });

		expect(scenario).toHaveBeenCalledTimes(1);
		expect(scenario).toHaveBeenCalledWith("run_8");
		expect(load).not.toHaveBeenCalled();
	});

	it("watches nothing for a run event that is not a start", () => {
		const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
		const scenario = vi
			.spyOn(scenarioRunService, "startMonitoring")
			.mockImplementation(() => {});
		const { emit } = mounted();

		// A delete, a stop, a baseline change: the run is named, and it is not
		// live. Attaching here would open a stream on a finished run and hold a
		// wake lock for it.
		emit({ entity: "run", runId: "run_9" });
		// And a family that is not runs at all.
		emit({ entity: "collection", collectionId: "col_1" });

		expect(load).not.toHaveBeenCalled();
		expect(scenario).not.toHaveBeenCalled();
	});

	it("drops its listener when the app unmounts", () => {
		const { unsubscribe, unmount } = mounted();
		expect(unsubscribe).not.toHaveBeenCalled();
		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("does nothing outside Electron, where there is no bridge", () => {
		bridged(null);
		expect(() => renderHook(() => useRunWatchers())).not.toThrow();
	});
});
