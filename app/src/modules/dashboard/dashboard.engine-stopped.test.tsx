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
 * A load test whose engine's process ended under it (#3605): the dashboard
 * says so, offers Restart, and once an engine serves again loads the run's
 * stored report - without the header ever reading live in between.
 *
 * Driven through the real header, store and fetch effect; only the report
 * request, the restart and the metrics view are stubbed, and the clock is
 * fake because the effect owns the delay.
 *
 * No notification comes from here: the engine-lost one is the only word the
 * user gets for the stop, and the stored report's arrival adds none.
 *
 * Mutation checks: treat `engineStopped` as live in `isDashboardRunLive` and
 * the pill and Stop cases redden; fetch without `serving` in `index.tsx` and
 * the "not before an engine serves" case reddens; drop the engine-stopped
 * abandon flag and the capped case reddens (it keeps fetching); route the
 * fetch through `awaitingReport` and the "never live" case reddens; render
 * the notice for `engineStopped` nowhere and the notice cases redden; offer
 * Restart while serving and the serving case reddens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { TIMING } from "@/config/timing";
import { isDashboardRunLive, useDashboardStore, useEngineStore } from "@/stores";
import type { RunReport } from "@/types";
import { apiService } from "@/services";
import { systemNotify } from "@/services/notify";
import LoadTestDashboard from "./index";

vi.mock("./components", async (importActual) => ({
	...(await importActual<typeof import("./components")>()),
	MetricsView: () => <div data-testid="live-metrics" />,
}));

const restart = vi.hoisted(() => vi.fn());
const restarting = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useEngineRestart", () => ({
	useEngineRestart: () => ({ restart, isRestarting: restarting.value }),
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn(), stopRun: vi.fn() },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		settleOnStoredReport: vi.fn(),
	},
}));

const NOTICE =
	"Vayu's engine stopped while this load test was running, and the test stopped with it.";

const ENGINE_INITIAL = useEngineStore.getState();
const DASHBOARD_INITIAL = useDashboardStore.getState();

function orphanReport(): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "failed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: 10,
			successfulRequests: 10,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 10,
		},
		latency: { min: 1, max: 2, avg: 1, p50: 1, p90: 1, p95: 1, p99: 2 },
		statusCodes: { "200": 10 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

function setEngine(status: "connected" | "unreachable"): void {
	act(() => useEngineStore.setState({ engineStatus: status, engineCrashAheadOfPoll: false }));
}

function renderEngineStoppedRun() {
	useDashboardStore.getState().startRun("run_1");
	useDashboardStore.getState().engineStopped("run_1");
	return render(withQueryClient(<LoadTestDashboard />));
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/**
 * The report request, held until the case answers it. The effect's delay is
 * the fake clock's, but its loading flag only re-arms it once a render has seen
 * it set, and an answer that lands inside the same `act` as the timer would
 * hide that render. So a round fires the timer, then fails the request apart.
 */
async function failedFetchRound(): Promise<void> {
	const held: Array<(error: Error) => void> = [];
	vi.mocked(apiService.getRunReport).mockImplementationOnce(
		() => new Promise((_, reject) => held.push(reject))
	);
	await advance(TIMING.REPORT_INITIAL_DELAY_MS);
	await act(async () => held.forEach((reject) => reject(new Error("engine busy"))));
}

/** Rounds of failure until the cap is spent, and then some. */
async function failFetches(rounds: number): Promise<void> {
	for (let i = 0; i < rounds; i++) await failedFetchRound();
}

const notice = () => screen.queryByText(NOTICE);
const runningPill = () => screen.queryByText("Running");
const stopButton = () => screen.queryByRole("button", { name: /stop/i });

beforeEach(() => {
	vi.useFakeTimers();
	useEngineStore.setState(ENGINE_INITIAL, true);
	useDashboardStore.setState(DASHBOARD_INITIAL, true);
	restart.mockReset();
	restarting.value = false;
	vi.mocked(apiService.getRunReport).mockReset();
	setEngine("unreachable");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the dashboard of a load test the engine stopped under", () => {
	it("says so, with no Running pill and no Stop", () => {
		renderEngineStoppedRun();

		expect(notice()).toBeInTheDocument();
		expect(runningPill()).toBeNull();
		expect(stopButton()).toBeNull();
		expect(document.querySelector("[data-status]")).toBeNull();
	});

	it("offers Restart, through the one restart the Dock and Settings share", () => {
		renderEngineStoppedRun();

		fireEvent.click(screen.getByRole("button", { name: "Restart" }));

		expect(restart).toHaveBeenCalledTimes(1);
	});

	it("reads Restarting and cannot be pressed again while a restart runs", () => {
		restarting.value = true;
		renderEngineStoppedRun();

		const button = screen.getByRole("button", { name: "Restarting…" });
		expect(button).toBeDisabled();
	});

	it("offers no Restart once an engine serves, keeping the notice until the report lands", () => {
		vi.mocked(apiService.getRunReport).mockReturnValue(new Promise(() => {}));
		setEngine("connected");
		renderEngineStoppedRun();

		expect(notice()).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
	});

	it("fetches nothing while no engine serves", async () => {
		renderEngineStoppedRun();

		await advance(TIMING.REPORT_INITIAL_DELAY_MS + TIMING.REPORT_RETRY_DELAY_MS * 10);

		expect(apiService.getRunReport).not.toHaveBeenCalled();
	});

	it("renders the stored report once an engine serves, never live on the way", async () => {
		vi.mocked(apiService.getRunReport).mockResolvedValue(orphanReport());
		renderEngineStoppedRun();
		const live: boolean[] = [];
		const unsubscribe = useDashboardStore.subscribe((s) =>
			live.push(isDashboardRunLive(s.phase))
		);

		setEngine("connected");
		await advance(TIMING.REPORT_INITIAL_DELAY_MS);
		unsubscribe();

		expect(apiService.getRunReport).toHaveBeenCalledWith("run_1");
		expect(useDashboardStore.getState().phase).toMatchObject({
			phase: "finished",
			kind: "failed",
		});
		expect(live).not.toContain(true);
		expect(notice()).toBeNull();
		expect(screen.getByRole("tab", { name: "Sampled requests" })).toBeInTheDocument();
	});

	it("posts no notification of its own: not for the stop, the restart or the report", async () => {
		const post = vi.spyOn(systemNotify, "post").mockImplementation(() => {});
		vi.mocked(apiService.getRunReport).mockResolvedValue(orphanReport());
		renderEngineStoppedRun();
		fireEvent.click(screen.getByRole("button", { name: "Restart" }));

		setEngine("connected");
		await advance(TIMING.REPORT_INITIAL_DELAY_MS);

		expect(useDashboardStore.getState().phase.phase).toBe("finished");
		expect(post).not.toHaveBeenCalled();
		post.mockRestore();
	});

	it("keeps the notice and stops asking when the report cannot be read", async () => {
		renderEngineStoppedRun();

		setEngine("connected");
		await failFetches(TIMING.REPORT_MAX_ATTEMPTS + 4);
		const asked = vi.mocked(apiService.getRunReport).mock.calls.length;
		await failFetches(4);

		// Cap + 1: the attempts are spent, then the next failure ends it.
		expect(asked).toBe(TIMING.REPORT_MAX_ATTEMPTS + 1);
		expect(vi.mocked(apiService.getRunReport)).toHaveBeenCalledTimes(asked);
		expect(useDashboardStore.getState().phase).toEqual({ phase: "engineStopped" });
		expect(notice()).toBeInTheDocument();
		expect(runningPill()).toBeNull();
		expect(stopButton()).toBeNull();
	});

	it("tries again when the engine comes back after an abandoned attempt", async () => {
		renderEngineStoppedRun();
		setEngine("connected");
		await failFetches(TIMING.REPORT_MAX_ATTEMPTS + 4);
		setEngine("unreachable");
		vi.mocked(apiService.getRunReport).mockReset().mockResolvedValue(orphanReport());

		setEngine("connected");
		await advance(TIMING.REPORT_INITIAL_DELAY_MS);

		expect(useDashboardStore.getState().phase.phase).toBe("finished");
	});
});
