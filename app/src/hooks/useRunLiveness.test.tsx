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
 * Each source `useRunLiveness` joins, alone, and that it follows the stores
 * (#3351). How the stored status and the streams combine is `isRunLive`'s
 * table in `lib/run-status.test.ts`; this pins which store state counts as
 * "a stream says this run is live".
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import type { RunReport } from "@/types";
import { useRunLiveness } from "./useRunLiveness";

const RUN = "run_1";

function liveness(status?: string, runId: string | null = RUN): boolean {
	return renderHook(() => useRunLiveness(runId, status)).result.current;
}

afterEach(() => {
	useDashboardStore.setState({ currentRunId: null, phase: { phase: "idle" } });
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
});

describe("useRunLiveness", () => {
	const SOURCES: ReadonlyArray<{ name: string; arrange: () => void; live: boolean }> = [
		{ name: "nothing holds the run", arrange: () => {}, live: false },
		{
			name: "the dashboard streams it",
			arrange: () => useDashboardStore.getState().startRun(RUN),
			live: true,
		},
		{
			// Mutation check: test `phase === "streaming"` in the hook and this
			// row reddens - History would say the run ended while the engine runs it.
			name: "the dashboard lost its stream",
			arrange: () => {
				useDashboardStore.getState().startRun(RUN);
				useDashboardStore.getState().streamLost(RUN, "socket closed");
			},
			live: true,
		},
		{
			name: "the dashboard's run was stopped",
			arrange: () => {
				useDashboardStore.getState().startRun(RUN);
				useDashboardStore.getState().stopRun(RUN);
			},
			live: false,
		},
		{
			// Mutation check: drop the `currentRunId === runId` comparison and
			// every History tab says its run is live while any load run streams.
			name: "the dashboard streams another run",
			arrange: () => useDashboardStore.getState().startRun("run_other"),
			live: false,
		},
		{
			name: "a collection run's stream carries it",
			arrange: () => useScenarioRunStore.getState().startRun(RUN),
			live: true,
		},
		{
			name: "the collection run's stream has ended",
			arrange: () => {
				useScenarioRunStore.getState().startRun(RUN);
				useScenarioRunStore.getState().setStreaming(RUN, false);
			},
			live: false,
		},
		{
			name: "a collection run streams another run",
			arrange: () => useScenarioRunStore.getState().startRun("run_other"),
			live: false,
		},
	];

	it.each(SOURCES)("with no stored status, is $live when $name", ({ arrange, live }) => {
		arrange();
		expect(liveness()).toBe(live);
	});

	it("is live from a stored in-progress status with no stream at all", () => {
		expect(liveness("running")).toBe(true);
		expect(liveness("pending")).toBe(true);
	});

	it("is not live once the stored status is terminal, whatever a stream still says", () => {
		useDashboardStore.getState().startRun(RUN);
		useScenarioRunStore.getState().startRun(RUN);
		expect(liveness("completed")).toBe(false);
	});

	it("reads no store for a run it was not given", () => {
		useDashboardStore.getState().startRun(RUN);
		expect(liveness(undefined, null)).toBe(false);
	});

	it("follows the dashboard as its run settles", () => {
		useDashboardStore.getState().startRun(RUN);
		const { result } = renderHook(() => useRunLiveness(RUN, undefined));
		expect(result.current).toBe(true);

		act(() =>
			useDashboardStore
				.getState()
				.setFinalReport(RUN, { metadata: { status: "completed" } } as RunReport)
		);

		expect(result.current).toBe(false);
	});
});
