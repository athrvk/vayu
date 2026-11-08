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
import { act, renderHook } from "@testing-library/react";
import { useRunWatchers } from "./useRunWatchers";
import { apiService } from "@/services/api";
import { loadTestService } from "@/services/load-test-service";
import { scenarioRunService } from "@/services/scenario-run-service";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import { useTabsStore } from "@/stores/tabs-store";
import { useToastStore } from "@/stores/toast-store";
import type { McpDataChangedEvent, Run, RunConfigSnapshot } from "@/types/domain";

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

/** A `GET /runs/:id` body carrying only the snapshot, which is all the hook reads. */
function runRow(id: string, configSnapshot?: RunConfigSnapshot): Run {
	return { id, type: "load", status: "running", startTime: 0, endTime: 0, configSnapshot };
}

/** Let the hook's pending `getRun` promise chain settle. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	useDashboardStore.setState({
		currentRunId: null,
		phase: { phase: "idle" },
		loadTestConfig: null,
		requestInfo: null,
	});
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
	useToastStore.setState({ toasts: [] });
	bridged(null);
	vi.restoreAllMocks();
});

describe("useRunWatchers", () => {
	it("watches a load run an agent started, with the store pointed at it first", () => {
		const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
		const scenario = vi
			.spyOn(scenarioRunService, "startMonitoring")
			.mockImplementation(() => {});
		vi.spyOn(apiService, "getRun").mockResolvedValue(runRow("run_7"));
		const { emit } = mounted();

		emit({ entity: "run", startedRun: { runId: "run_7", kind: "load" } });

		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith("run_7");
		expect(scenario).not.toHaveBeenCalled();
		// The service states that its caller registers the run: without this the
		// dashboard opened later finds no current run and the ticks that arrived
		// while it was closed belong to nothing.
		expect(useDashboardStore.getState().currentRunId).toBe("run_7");
		expect(useDashboardStore.getState().phase).toEqual({ phase: "streaming" });
	});

	describe("configuring a load run from its row (#1935)", () => {
		const SNAPSHOT: RunConfigSnapshot = {
			url: "https://api.example.com/items",
			method: "POST",
			mode: "ramp_up",
			duration: "30m",
			concurrency: 50,
			startConcurrency: 5,
			rampUpDuration: "5m",
		};

		it("reads the run once and sets the config and request the dashboard shows", async () => {
			// Mutation check: drop the `configureFromRunRow` call and no read
			// happens - the dashboard renders constant_rps cards, no URL and no
			// keep-awake prompt for a half-hour run.
			vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			const getRun = vi
				.spyOn(apiService, "getRun")
				.mockResolvedValue(runRow("run_20", SNAPSHOT));
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_20", kind: "load" } });
			await settled();

			expect(getRun).toHaveBeenCalledTimes(1);
			expect(getRun).toHaveBeenCalledWith("run_20");
			const state = useDashboardStore.getState();
			expect(state.loadTestConfig).toEqual({
				mode: "ramp_up",
				duration: "30m",
				concurrency: 50,
				startConcurrency: 5,
				rampUpDuration: "5m",
			});
			expect(state.requestInfo).toEqual({
				method: "POST",
				url: "https://api.example.com/items",
			});
			expect(state.currentRunId).toBe("run_20");
		});

		it("drops a response that arrives after another run took the dashboard", async () => {
			// Mutation check: remove the `currentRunId` comparison and run A's row
			// overwrites run B's config.
			vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			let resolveA: (run: Run) => void = () => {};
			vi.spyOn(apiService, "getRun").mockImplementation((id) =>
				id === "run_a"
					? new Promise<Run>((resolve) => {
							resolveA = resolve;
						})
					: Promise.resolve(runRow(id, { ...SNAPSHOT, mode: "iterations" }))
			);
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_a", kind: "load" } });
			// Stopped, so it no longer holds the dashboard against run B.
			useDashboardStore.getState().stopRun("run_a");
			emit({ entity: "run", startedRun: { runId: "run_b", kind: "load" } });
			await settled();
			resolveA(runRow("run_a", SNAPSHOT));
			await settled();

			const state = useDashboardStore.getState();
			expect(state.currentRunId).toBe("run_b");
			expect(state.loadTestConfig?.mode).toBe("iterations");
		});

		it("leaves the dashboard and its error alone when the row cannot be read", async () => {
			// Mutation check: replace the swallow with `streamLost(...)` and the
			// lost-stream callout appears over a stream that is fine.
			vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			vi.spyOn(apiService, "getRun").mockRejectedValue(new Error("engine unreachable"));
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_21", kind: "load" } });
			await settled();

			const state = useDashboardStore.getState();
			expect(state.phase).toEqual({ phase: "streaming" });
			expect(state.loadTestConfig).toBeNull();
			expect(state.requestInfo).toBeNull();
			expect(state.currentRunId).toBe("run_21");
		});
	});

	/*
	 * The engine has already started the agent's run, so the app cannot refuse
	 * it; what it refuses is taking the dashboard from the run the user is
	 * watching (#3351). Mutation check: drop the `canStartLoadRun()` test from
	 * the listener and every case here reddens - the live run is replaced and
	 * nothing is said.
	 */
	describe("an agent's load run while another run is live", () => {
		const LIVE_RUNS = [
			{
				name: "a streaming load run",
				hold: () => useDashboardStore.getState().startRun("run_live"),
			},
			{
				// A lost stream is live: the engine still runs the load test.
				name: "a load run whose stream was lost",
				hold: () => {
					useDashboardStore.getState().startRun("run_live");
					useDashboardStore.getState().streamLost("run_live", "socket closed");
				},
			},
			{
				// One stream client serves both: attaching would take it.
				name: "a streaming collection run",
				hold: () => useScenarioRunStore.getState().startRun("run_live"),
			},
		];

		it.each(LIVE_RUNS)("leaves $name watched and announces the agent's", ({ hold }) => {
			const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			const getRun = vi.spyOn(apiService, "getRun").mockResolvedValue(runRow("run_agent"));
			hold();
			const before = useDashboardStore.getState();
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_agent", kind: "load" } });

			expect(load).not.toHaveBeenCalled();
			expect(getRun).not.toHaveBeenCalled();
			const after = useDashboardStore.getState();
			expect(after.currentRunId).toBe(before.currentRunId);
			expect(after.phase).toBe(before.phase);
			const toasts = useToastStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0]).toMatchObject({
				variant: "warning",
				message:
					"An agent started a load test while another run is live, so it has no live view.",
				action: { label: "View run" },
			});
		});

		it("opens the agent's run from the toast", () => {
			vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			useDashboardStore.getState().startRun("run_live");
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_agent", kind: "load" } });
			act(() => useToastStore.getState().toasts[0]?.action?.onClick());

			const { openTabs, activeTabId } = useTabsStore.getState();
			const active = openTabs.find((tab) => tab.id === activeTabId);
			expect(active).toMatchObject({ type: "run", entityId: "run_agent" });
		});

		it("adopts the agent's run once the live run has ended", () => {
			const load = vi.spyOn(loadTestService, "startMonitoring").mockImplementation(() => {});
			vi.spyOn(apiService, "getRun").mockResolvedValue(runRow("run_agent"));
			useDashboardStore.getState().startRun("run_live");
			useDashboardStore.getState().stopRun("run_live");
			const { emit } = mounted();

			emit({ entity: "run", startedRun: { runId: "run_agent", kind: "load" } });

			expect(load).toHaveBeenCalledWith("run_agent");
			expect(useDashboardStore.getState().currentRunId).toBe("run_agent");
			expect(useToastStore.getState().toasts).toHaveLength(0);
		});
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
