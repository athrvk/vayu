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
 * Every failure the dashboard can record reaches the screen, with a way out
 * that works (#1925).
 *
 * This used to be a source scan that the writer and the reader of the stream
 * error existed. Both did, and neither was reached: a real drop never set the
 * error, and the report callout's Retry re-armed no effect. So it is driven
 * end to end here - the real `LoadTestService` against the real store, and the
 * real dashboard reading it. Only the engine and the SSE socket are stubbed,
 * and the dashboard's own children, whose suites cover them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
	isDashboardRunLive,
	useDashboardStore,
	useScenarioRunStore,
	useTabsStore,
	useToastStore,
} from "@/stores";
import { TIMING } from "@/config/timing";
import type { RunReport } from "@/types";

const { mockGetRunReport, mockStartMonitoring, mockIsMonitoring, mockStopRun, headerProps } =
	vi.hoisted(() => ({
		mockGetRunReport: vi.fn(),
		mockStartMonitoring: vi.fn(),
		mockIsMonitoring: vi.fn(),
		mockStopRun: vi.fn(),
		headerProps: [] as Record<string, unknown>[],
	}));
// What the real service reaches the engine through.
vi.mock("@/services/api", () => ({ apiService: { getRunReport: mockGetRunReport } }));
vi.mock("@/services/sse-client", () => ({
	sseClient: { connect: vi.fn(), disconnect: vi.fn() },
}));
// What the dashboard reaches the service through: Reconnect is asserted on the
// call it makes, and `isMonitoring` (true unless a case says otherwise) keeps
// the mount check from reconnecting on its own.
vi.mock("@/services", () => ({
	apiService: { getRunReport: mockGetRunReport, stopRun: mockStopRun },
	loadTestService: {
		isMonitoring: mockIsMonitoring,
		startMonitoring: mockStartMonitoring,
		stopMonitoring: vi.fn(),
	},
}));
// The header's props are what its pill and Stop button are drawn from
// (`DashboardHeader.status.test.tsx` holds that mapping).
vi.mock("./components", () => ({
	DashboardHeader: (props: Record<string, unknown>) => {
		headerProps.push(props);
		return null;
	},
	MetricsView: () => null,
}));
// The collection target is read from the run's row; these cases are about the
// live configuration, not that lookup (`dashboard.collection-run.test.tsx`).
vi.mock("./hooks/useCollectionRunTarget", () => ({ useCollectionRunTarget: () => ({}) }));

vi.mock("@/modules/history/main/LoadTestDetail", () => ({ default: () => null }));

import { loadTestService } from "@/services/load-test-service";
import LoadTestDashboard from "./index";

const reportWith = (status: string) =>
	({ summary: { totalRequests: 10 }, latency: {}, metadata: { status } }) as unknown as RunReport;

/** `handleClose` is private; the SSE client calls it, with `null` for a drop. */
function dropStream(): Promise<void> {
	return (
		loadTestService as unknown as { handleClose: (status: null) => Promise<void> }
	).handleClose(null);
}

/** `handleError` is private; the SSE client calls it when the stream fails. */
function failStream(message: string): void {
	(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
		new Error(message)
	);
}

const lastHeader = () => headerProps[headerProps.length - 1];

/** How long a stubbed engine call takes to answer. */
const ROUND_TRIP_MS = 10;

/** Run every timer the dashboard can arm, and the promises they settle. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/**
 * Settle a round trip after the call, not in the same tick: the report effect
 * re-arms on its loading flag going true and back, and two updates landing
 * before one render are batched into no change at all.
 */
function answerAfterRoundTrip(report: RunReport): Promise<RunReport> {
	return new Promise((resolve) => setTimeout(() => resolve(report), ROUND_TRIP_MS));
}

/** The first report attempt and every retry the cap allows, each its own `act`. */
async function spendEveryReportAttempt(): Promise<void> {
	for (let i = 0; i <= TIMING.REPORT_MAX_ATTEMPTS; i++) {
		await advance(i === 0 ? TIMING.REPORT_INITIAL_DELAY_MS : TIMING.REPORT_RETRY_DELAY_MS);
		await advance(ROUND_TRIP_MS);
	}
}

describe("dashboard error surfacing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockGetRunReport.mockReset();
		mockStartMonitoring.mockReset();
		mockIsMonitoring.mockReset().mockReturnValue(true);
		mockStopRun.mockReset().mockResolvedValue(undefined);
		headerProps.length = 0;
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		useScenarioRunStore.setState({ runId: null, isStreaming: false });
	});

	/*
	 * A stream that ends with no `complete` frame, for a run the engine still
	 * reports as running. Mutation checks: drop the `isRunInProgress` branch in
	 * `LoadTestService.handleClose` and the run finishes "completed" with no
	 * callout; arm the dashboard's report effect on `streamLost` too and that
	 * effect fetches the live report anyway.
	 */
	it("shows a dropped stream for a live run as lost, not Completed", async () => {
		mockGetRunReport.mockResolvedValue(reportWith("running"));
		useDashboardStore.getState().startRun("run_drop");
		loadTestService.startMonitoring("run_drop");
		render(createElement(LoadTestDashboard));

		await act(() => dropStream());

		const { phase } = useDashboardStore.getState();
		expect(phase.phase).toBe("streamLost");
		expect(isDashboardRunLive(phase)).toBe(true);
		expect(lastHeader()).toMatchObject({ live: true, endedAs: null });
		expect(screen.getByText("Lost the live metrics stream")).toBeTruthy();

		// The run is live, so the stored report is not what the page waits on.
		const fetched = mockGetRunReport.mock.calls.length;
		await advance(TIMING.REPORT_INITIAL_DELAY_MS * 2);
		expect(mockGetRunReport.mock.calls.length).toBe(fetched);

		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(mockStartMonitoring).toHaveBeenCalledWith("run_drop");
	});

	/*
	 * A stream error left the run "streaming" beside its message, and a
	 * superseded stream left it neither streaming nor settled: the first drew
	 * Running over a dead stream as if nothing had happened, the second drew no
	 * pill at all while Stop still showed (#3351). Both are a lost stream on a
	 * run the engine is still executing.
	 *
	 * Mutation check: make `isDashboardRunLive` answer false for `streamLost`
	 * and every case reddens on `live`; write `handleError` back to leave the
	 * phase streaming and the first case reddens on the phase.
	 */
	it.each([
		["a stream error", () => failStream("The connection to Vayu's engine closed.")],
		[
			"a collection run taking the stream",
			() =>
				(loadTestService as unknown as { handleSuperseded: () => void }).handleSuperseded(),
		],
	])("keeps the run live, with the callout, after %s", (_name, lose) => {
		mockGetRunReport.mockResolvedValue(reportWith("running"));
		useDashboardStore.getState().startRun("run_lost");
		loadTestService.startMonitoring("run_lost");
		render(createElement(LoadTestDashboard));

		act(() => lose());

		const { phase } = useDashboardStore.getState();
		expect(phase.phase).toBe("streamLost");
		expect(isDashboardRunLive(phase)).toBe(true);
		expect(lastHeader()).toMatchObject({ live: true, endedAs: null });
		expect(screen.getByText("Lost the live metrics stream")).toBeTruthy();
		loadTestService.stopMonitoring();
	});

	/*
	 * The stream stopped, the report could not be read, and the fetch gave up.
	 * Retry used to clear the error and nothing else: the effect that set it
	 * did not depend on it, and the retry-capped one was gated on a mode the
	 * run had not reached, so the callout went away and the page sat with no
	 * report. Mutation check: drop `reportError` from the effect's
	 * dependencies and Retry issues no fetch.
	 */
	it("fetches the report once more when Retry is pressed", async () => {
		// Rejected a round trip later, not in the same tick: the effect re-arms
		// on its loading flag going true and back, and two updates landing
		// before one render are batched into no change at all. For the same
		// reason each delay and each round trip below is its own `act`.
		mockGetRunReport.mockImplementation(
			() =>
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("Couldn't reach Vayu's engine.")),
						ROUND_TRIP_MS
					)
				)
		);
		useDashboardStore.getState().startRun("run_retry");
		useDashboardStore.getState().streamClosed("run_retry");
		render(createElement(LoadTestDashboard));

		await spendEveryReportAttempt();
		expect(screen.getByText("Couldn't load the run report")).toBeTruthy();
		expect(useDashboardStore.getState().phase.phase).toBe("reportError");

		const fetched = mockGetRunReport.mock.calls.length;
		mockGetRunReport.mockResolvedValueOnce(reportWith("completed"));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await advance(TIMING.REPORT_INITIAL_DELAY_MS);

		expect(mockGetRunReport.mock.calls.length - fetched).toBe(1);
		expect(mockGetRunReport).toHaveBeenLastCalledWith("run_retry");
		expect(useDashboardStore.getState().phase).toMatchObject({
			phase: "finished",
			kind: "completed",
		});
		expect(screen.queryByText("Couldn't load the run report")).toBeNull();
	});

	/*
	 * The stream closed but the stored report kept saying running through every
	 * attempt. Giving up to `reportError` took the pill and Stop away while the
	 * engine still generated load (#3351). Mutation check: give up through
	 * `reportFailed` here as before and the phase reddens on `streamLost`.
	 */
	it("ends a report that never stops saying running on the lost-stream callout", async () => {
		mockGetRunReport.mockImplementation(() => answerAfterRoundTrip(reportWith("running")));
		useDashboardStore.getState().startRun("run_live");
		useDashboardStore.getState().streamClosed("run_live");
		render(createElement(LoadTestDashboard));

		await spendEveryReportAttempt();

		const { phase } = useDashboardStore.getState();
		expect(phase).toEqual({
			phase: "streamLost",
			message:
				"The stream closed, but Vayu's engine still reports this load test as running.",
		});
		expect(isDashboardRunLive(phase)).toBe(true);
		expect(lastHeader()).toMatchObject({ live: true, endedAs: null });
		expect(screen.getByText("Lost the live metrics stream")).toBeTruthy();
		expect(screen.queryByText("Couldn't load the run report")).toBeNull();

		// Reconnect is the user's to press: nothing fetches on its own from here.
		const fetched = mockGetRunReport.mock.calls.length;
		await advance(TIMING.REPORT_INITIAL_DELAY_MS * 2);
		expect(mockGetRunReport.mock.calls.length).toBe(fetched);

		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(mockStartMonitoring).toHaveBeenCalledWith("run_live");
	});

	// Mutation check: give up through `streamLost` alone and the stopped run
	// stays awaiting, the effect re-arms, and the fetch never ends.
	it("keeps Retry for a run the user stopped whose report still says running", async () => {
		mockGetRunReport.mockImplementation(() => answerAfterRoundTrip(reportWith("running")));
		useDashboardStore.getState().startRun("run_stopped");
		useDashboardStore.getState().stopRun("run_stopped");
		render(createElement(LoadTestDashboard));

		await spendEveryReportAttempt();

		const { phase } = useDashboardStore.getState();
		expect(phase).toMatchObject({ phase: "reportError", stopped: true });
		expect(isDashboardRunLive(phase)).toBe(false);
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
	});

	it("stops a run from the lost-stream callout the report left it on", async () => {
		mockGetRunReport.mockImplementation(() => answerAfterRoundTrip(reportWith("running")));
		useDashboardStore.getState().startRun("run_stop");
		useDashboardStore.getState().streamClosed("run_stop");
		render(createElement(LoadTestDashboard));
		await spendEveryReportAttempt();
		expect(useDashboardStore.getState().phase.phase).toBe("streamLost");

		const onStop = lastHeader().onStop as () => Promise<void>;
		await act(() => onStop());

		expect(mockStopRun).toHaveBeenCalledWith("run_stop");
		expect(useDashboardStore.getState().phase).toEqual({
			phase: "awaitingReport",
			stopped: true,
		});
	});

	/*
	 * `sseClient` holds one stream, so re-attaching the dashboard's run while a
	 * collection run streams would take that run's live view (#3351).
	 * Mutation check: drop the `canReattachLoadRun` check from Reconnect and the
	 * first case calls `startMonitoring`; drop it from `reattachOnMount` and the
	 * mount case does.
	 */
	describe("beside a streaming collection run", () => {
		function loseStreamToCollectionRun(runId: string): void {
			// Answers the mount check, which asks whether the run is still going.
			mockGetRunReport.mockResolvedValue(reportWith("running"));
			useDashboardStore.getState().startRun(runId);
			useDashboardStore
				.getState()
				.streamLost(runId, "A collection run took over the live stream.");
			useScenarioRunStore.getState().startRun("coll_1");
		}

		it("refuses Reconnect, opening the collection run and saying why", () => {
			loseStreamToCollectionRun("run_held");
			render(createElement(LoadTestDashboard));

			fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

			expect(mockStartMonitoring).not.toHaveBeenCalled();
			const toasts = useToastStore.getState().toasts;
			expect(toasts[toasts.length - 1]).toMatchObject({
				message: "A collection run is already running.",
				variant: "warning",
			});
			const { openTabs, activeTabId } = useTabsStore.getState();
			expect(openTabs.find((t) => t.id === activeTabId)).toMatchObject({
				type: "run",
				entityId: "coll_1",
			});
			// The dashboard's run is untouched: still live, still on its callout.
			expect(useDashboardStore.getState().phase.phase).toBe("streamLost");
		});

		it("reconnects once the collection run's stream has ended", () => {
			loseStreamToCollectionRun("run_freed");
			useScenarioRunStore.getState().setStreaming("coll_1", false);
			render(createElement(LoadTestDashboard));

			fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

			expect(mockStartMonitoring).toHaveBeenCalledWith("run_freed");
		});

		it.each([
			["holds", true, 0],
			["has let go of", false, 1],
		])(
			"re-attaches on mount only when no collection run %s the stream",
			async (_name, collectionStreaming, attaches) => {
				mockIsMonitoring.mockReturnValue(false);
				loseStreamToCollectionRun("run_mount");
				useScenarioRunStore.getState().setStreaming("coll_1", collectionStreaming);
				render(createElement(LoadTestDashboard));

				await advance(ROUND_TRIP_MS);

				expect(mockGetRunReport).toHaveBeenCalledWith("run_mount");
				expect(mockStartMonitoring).toHaveBeenCalledTimes(attaches);
			}
		);
	});
});
