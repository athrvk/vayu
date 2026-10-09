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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoadRunInProgress from "./LoadRunInProgress";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { useDashboardStore, useTabsStore, useToastStore } from "@/stores";

const stopRun = vi.fn<(id: string) => Promise<unknown>>();
vi.mock("@/services/api", () => ({
	apiService: { stopRun: (id: string) => stopRun(id) },
}));

beforeEach(() => {
	stopRun.mockReset();
	stopRun.mockResolvedValue({});
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
});
