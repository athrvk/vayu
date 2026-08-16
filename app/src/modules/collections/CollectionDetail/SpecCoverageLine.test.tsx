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
 * The Spec tab's last-run coverage line (issue #629).
 *
 * One line, and the three ways it could lie: reporting a figure for a
 * collection that has never been run, reporting one for a run that was not
 * measured against a contract, and recomputing rather than reading what the run
 * actually recorded.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { RunCoverage, RunReport } from "@/types/domain";

const lastRun = vi.fn();
const runReport = vi.fn();

const openTab = vi.fn();
vi.mock("@/stores", () => ({
	useTabsStore: (selector: (s: { openTab: typeof openTab }) => unknown) => selector({ openTab }),
}));

vi.mock("@/queries/runs", () => ({
	useLastCollectionRunQuery: () => lastRun(),
	useRunReportQuery: (runId: string | null) => runReport(runId),
}));

const { default: SpecCoverageLine } = await import("./SpecCoverageLine");

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const coverage: RunCoverage = {
	operationsTotal: 18,
	operationsCovered: 14,
	declaredResponsesTotal: 41,
	declaredResponsesHit: 29,
	declaredResponseCoveragePct: 70.7,
	undeclaredStatusesSeen: 0,
	operations: [],
};

const run = { id: "run_1", startTime: Date.now() - 60_000 };

describe("SpecCoverageLine", () => {
	it("says nothing for a collection that has never been run", () => {
		lastRun.mockReturnValue({ data: { data: [] } });
		runReport.mockReturnValue({ data: undefined });

		const { container } = render(<SpecCoverageLine collectionId="col_1" />);

		expect(container).toBeEmptyDOMElement();
		// And no report is fetched for a run that does not exist.
		expect(runReport).toHaveBeenCalledWith(null);
	});

	it("says nothing when the last run was not measured against a contract", () => {
		// An absent `coverage` is "not measured", not "covered nothing" - the
		// line must not appear reading 0 of 0.
		lastRun.mockReturnValue({ data: { data: [run] } });
		runReport.mockReturnValue({ data: { coverage: undefined } as unknown as RunReport });

		const { container } = render(<SpecCoverageLine collectionId="col_1" />);

		expect(container).toBeEmptyDOMElement();
	});

	it("reports the run's own numbers, from the run's own report", () => {
		lastRun.mockReturnValue({ data: { data: [run] } });
		runReport.mockReturnValue({ data: { coverage } as unknown as RunReport });

		render(<SpecCoverageLine collectionId="col_1" />);

		expect(
			screen.getByText(/Last run covered 14 of 18 operations and 29 of 41 declared responses/)
		).toBeTruthy();
		expect(runReport).toHaveBeenCalledWith("run_1");
	});

	it("opens the run it describes, through the one opener", () => {
		lastRun.mockReturnValue({ data: { data: [run] } });
		runReport.mockReturnValue({ data: { coverage } as unknown as RunReport });

		render(<SpecCoverageLine collectionId="col_1" />);
		screen.getByRole("button").click();

		expect(openTab).toHaveBeenCalledWith({ type: "run", entityId: "run_1" });
	});
});
