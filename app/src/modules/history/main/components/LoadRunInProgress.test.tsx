/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare, screen, fireEvent, waitFor } from "@testing-library/react";
import LoadRunInProgress from "./LoadRunInProgress";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { useDashboardStore, useTabsStore, useToastStore } from "@/stores";

const stopRun = vi.fn<(id: string) => Promise<unknown>>();
const getRun = vi.fn<(id: string) => Promise<unknown>>();
vi.mock("@/services/api", () => ({
	apiService: { stopRun: (id: string) => stopRun(id), getRun: (id: string) => getRun(id) },
}));

/** The tab reads the run's phase off the same query History polls, so it needs a client. */
function render(ui: ReactElement) {
	return renderBare(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** `GET /runs/:id` of a run the engine still executes, with the phase it reports (absent: none). */
function activeRun(phase?: string) {
	return { id: "run-1", type: "load", status: "running", startTime: 1, endTime: null, phase };
}

beforeEach(() => {
	queryClient.clear();
	stopRun.mockReset();
	stopRun.mockResolvedValue({});
	getRun.mockReset();
	getRun.mockResolvedValue(activeRun());
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useDashboardStore.setState({ currentRunId: null });
	useToastStore.setState({ toasts: [] });
});

afterEach(() => vi.restoreAllMocks());

describe("LoadRunInProgress", () => {
	it("stops the run and refreshes what the tab shows of it", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		render(<LoadRunInProgress runId="run-1" />);

		fireEvent.click(screen.getByRole("button", { name: /stop/i }));

		await waitFor(() => expect(stopRun).toHaveBeenCalledWith("run-1"));
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail("run-1") })
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.report("run-1") });
		invalidate.mockRestore();
	});

	it("tells the user when the stop failed, and offers a retry", async () => {
		stopRun.mockRejectedValue(new Error("Engine unreachable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<LoadRunInProgress runId="run-1" />);

		fireEvent.click(screen.getByRole("button", { name: /stop/i }));

		await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
		const toast = useToastStore.getState().toasts[0];
		expect(toast.message).toMatch(/couldn't stop the run - engine unreachable/i);
		expect(toast.action?.label).toBe("Try again");
		// The run is still going, so the button is back.
		await waitFor(() => expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy());
	});

	/*
	 * The dashboard shows the run this window streams. Mutation check: render
	 * the button unconditionally and the first case reddens.
	 */
	it("offers the dashboard only when this window is the one watching the run", () => {
		const { unmount } = render(<LoadRunInProgress runId="run-1" />);
		expect(screen.queryByRole("button", { name: /open dashboard/i })).toBeNull();
		unmount();

		useDashboardStore.setState({ currentRunId: "run-other" });
		const other = render(<LoadRunInProgress runId="run-1" />);
		expect(screen.queryByRole("button", { name: /open dashboard/i })).toBeNull();
		other.unmount();

		useDashboardStore.setState({ currentRunId: "run-1" });
		render(<LoadRunInProgress runId="run-1" />);
		fireEvent.click(screen.getByRole("button", { name: /open dashboard/i }));

		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toEqual(["dashboard"]);
	});

	/*
	 * The engine owns the phase (#3568): while it reports `draining` the one thing
	 * left to stop is the wait. Mutation check: drop the `label` prop from the
	 * button and the draining case reddens; read "draining" off anything but the
	 * run's `phase` (elapsed against the plan) and the absent and unknown cases
	 * redden.
	 */
	describe("the run's phase", () => {
		it("reads Stop waiting while the engine reports the run draining", async () => {
			getRun.mockResolvedValue(activeRun("draining"));
			render(<LoadRunInProgress runId="run-1" />);

			expect(await screen.findByRole("button", { name: /^stop waiting$/i })).toBeTruthy();
		});

		it.each([["sending"], ["summarising"], ["settled"], [undefined], ["unheard-of"]])(
			"keeps Stop when the phase is %s",
			async (phase) => {
				getRun.mockResolvedValue(activeRun(phase));
				render(<LoadRunInProgress runId="run-1" />);

				// The run's fetch has landed in the cache before the label is judged.
				await waitFor(() =>
					expect(queryClient.getQueryData(queryKeys.runs.detail("run-1"))).toBeTruthy()
				);
				expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
			}
		);

		it("stops the run from the Stop waiting button too", async () => {
			getRun.mockResolvedValue(activeRun("draining"));
			render(<LoadRunInProgress runId="run-1" />);

			fireEvent.click(await screen.findByRole("button", { name: /^stop waiting$/i }));

			await waitFor(() => expect(stopRun).toHaveBeenCalledWith("run-1"));
		});
	});
});
