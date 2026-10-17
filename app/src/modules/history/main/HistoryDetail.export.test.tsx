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
 * The run tab's Export menu (#2139) is offered for a finished load run only.
 *
 * The engine refuses every other run (`read_exportable_run`), so a menu on a
 * send, a collection run or a load run still executing would be a control that
 * can only fail. The menu's own behaviour is `RunExportMenu.test.tsx`.
 *
 * Mutation check: mount the menu outside the `showsReport` gate in
 * `HistoryDetail` and the design, collection-run and in-progress cases red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { useTabsStore } from "@/stores";
import type { Run } from "@/types";
import HistoryDetail from "./HistoryDetail";

const runQuery = { data: undefined as Run | undefined, isLoading: false, error: null };
const reportQuery = {
	data: { metadata: { requestUrl: "https://api.test/orders", requestMethod: "GET" } },
	isLoading: false,
	error: null,
	refetch: vi.fn(),
};

vi.mock("@/queries", () => ({
	useRunQuery: () => runQuery,
	useRunReportQuery: () => reportQuery,
	useBaselineRunQuery: () => ({ data: null }),
	isRunNotFound: () => false,
	useCollectionsQuery: () => ({ data: [] }),
}));
vi.mock("@/services/api", () => ({ apiService: { exportRunReport: vi.fn() } }));
vi.mock("@/lib/download-text-file", () => ({ downloadTextFile: vi.fn() }));

vi.mock("./LoadTestDetail", () => ({ default: () => null }));
vi.mock("./DesignRunView", () => ({ default: () => null }));
vi.mock("./ScenarioRunView", () => ({ default: () => null }));
vi.mock("./components/LoadRunInProgress", () => ({ default: () => null }));

function run(overrides: Partial<Run>): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		configSnapshot: { url: "https://api.test/orders", method: "GET" },
		...overrides,
	} as Run;
}

function renderTab(loaded: Run) {
	runQuery.data = loaded;
	return render(withQueryClient(<HistoryDetail />));
}

const exportButton = () => screen.queryByRole("button", { name: "Export" });

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run_1" }],
		activeTabId: "t1",
	});
	vi.mocked(apiService.exportRunReport)
		.mockReset()
		.mockResolvedValue({
			text: "{}",
			fileName: "Orders.run.json",
			mimeType: "application/json",
			notes: { urlCredentialsOmitted: 0 },
		});
});
afterEach(cleanup);

describe("Export in the run header", () => {
	it.each(["completed", "stopped", "failed"] as const)(
		"is offered beside Copy for agent for a %s load run",
		(status) => {
			renderTab(run({ status }));
			expect(exportButton()).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Copy for agent" })).toBeInTheDocument();
		}
	);

	it.each([
		["a send", run({ type: "design" })],
		["a collection run", run({ type: "scenario", configSnapshot: {} })],
		["a running load run", run({ status: "running" })],
		["a pending load run", run({ status: "pending" })],
	])("is absent for %s", (_name, loaded) => {
		renderTab(loaded);
		expect(screen.getByRole("button", { name: "Copy for agent" })).toBeInTheDocument();
		expect(exportButton()).toBeNull();
	});

	it("exports the run the tab shows", async () => {
		renderTab(run({}));
		const trigger = exportButton()!;
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(trigger, { detail: 1 });
		fireEvent.click(await screen.findByRole("menuitem", { name: "Save as JSON" }));

		await waitFor(() =>
			expect(apiService.exportRunReport).toHaveBeenCalledWith({
				runId: "run_1",
				format: "json",
			})
		);
	});
});
