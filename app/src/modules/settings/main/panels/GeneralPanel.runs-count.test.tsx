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
 * Opening Settings must not read the run history (#2979).
 *
 * "N stored runs" is the `pagination.total` of a one-row page; paging the whole
 * history in 500-row requests to print one number was the cost of the panel
 * being open. The counts the Clear dialog states (what is pinned, what is still
 * running) are read when the user asks to clear, and the clear itself is the
 * engine's single `DELETE /runs`.
 *
 * Runs the real queries over a stubbed `listRuns`, so the request log is the
 * assertion. The stub answers totals only (`data` stays empty): the fixture is
 * the number 2000, not 2000 rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { RunListParams } from "@/types";
import GeneralPanel from "./GeneralPanel";

const TOTAL = 2000;
const PINNED = 3;
const RUNNING = 1;

let cleared = false;
const listRuns = vi.fn((params: RunListParams) => {
	let total = TOTAL;
	if (cleared) total = PINNED + RUNNING;
	else if (params.baseline === true) total = PINNED;
	else if (params.baseline === false && params.status === "running") total = RUNNING;
	else if (params.baseline === false && params.status === "pending") total = 0;
	return Promise.resolve({
		data: [],
		pagination: {
			total,
			limit: params.limit ?? 0,
			offset: params.offset ?? 0,
			hasMore: total > (params.limit ?? 0),
			returned: 0,
		},
	});
});
const clearRuns = vi.fn(() => {
	cleared = true;
	return Promise.resolve({ deleted: 1996, keptPinned: PINNED, deletedIds: [] as string[] });
});
const deleteRun = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRuns: (params: RunListParams) => listRuns(params),
		clearRuns: () => clearRuns(),
		deleteRun: (id: string) => deleteRun(id),
	},
}));

// Cards that reach outside the renderer or the run store; none is the subject.
vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));
vi.mock("./StartAtLoginCard", () => ({ StartAtLoginCard: () => null }));
vi.mock("./WorkspaceBackupCard", () => ({ WorkspaceBackupCard: () => null }));

function renderPanel() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
	return render(<GeneralPanel />, { wrapper });
}

beforeEach(() => {
	cleared = false;
	listRuns.mockClear();
	clearRuns.mockClear();
	deleteRun.mockClear();
	useToastStore.setState({ toasts: [] });
});

describe("GeneralPanel - stored run count", () => {
	it("reads the count from one one-row request on open", async () => {
		renderPanel();

		expect(await screen.findByText("2000 stored runs.")).toBeTruthy();

		expect(listRuns).toHaveBeenCalledTimes(1);
		expect(listRuns).toHaveBeenCalledWith({ limit: 1 });
	});

	it("reads what the dialog states only once the user asks to clear, then clears in one call", async () => {
		renderPanel();
		await screen.findByText("2000 stored runs.");
		expect(listRuns).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));
		const dialog = await screen.findByRole("dialog");

		expect(dialog).toHaveTextContent(
			"1996 stored runs and their metrics are removed permanently. 3 pinned baselines are kept. One run still in progress is kept. This can't be undone."
		);
		// The total, the pins, and the unpinned running and pending runs - each a
		// one-row page, never the list.
		const asked = listRuns.mock.calls.slice(1).map(([params]) => params);
		expect(asked).toHaveLength(4);
		for (const params of asked) {
			expect(params.limit).toBe(1);
			expect(params.offset).toBeUndefined();
		}
		expect(asked).toContainEqual({ baseline: true, limit: 1 });
		expect(asked).toContainEqual({ baseline: false, status: "running", limit: 1 });
		expect(asked).toContainEqual({ baseline: false, status: "pending", limit: 1 });
		// Asking is not clearing.
		expect(clearRuns).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /^clear history$/i }));

		await waitFor(() => expect(clearRuns).toHaveBeenCalledTimes(1));
		expect(deleteRun).not.toHaveBeenCalled();
		// The clear refreshes the count on screen.
		expect(await screen.findByText("4 stored runs.")).toBeTruthy();
	});
});
