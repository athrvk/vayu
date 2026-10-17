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
 * "Copy for agent" in the run tab's identity header (#2047).
 *
 * The header is above the per-type views, so one button serves every run
 * type. The run here is the loaded one (`GET /runs/:id`), which has no
 * `summary`; its name, method and path come off the snapshot, and the
 * snapshot's headers, auth and URL query stay off the clipboard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import HistoryDetail from "./HistoryDetail";
import { formatInstant } from "@/lib/time-value";
import { useTabsStore, useToastStore } from "@/stores";
import type { Run } from "@/types";

const SENTINEL = "s3cr3t-sentinel";
const START = 1_750_000_000_000;
const AT = formatInstant(START, "datetime");

const runQuery = { data: undefined as Run | undefined, isLoading: false, error: null };
const reportQuery = { data: {}, isLoading: false, error: null, refetch: vi.fn() };

vi.mock("@/queries", () => ({
	useRunQuery: () => runQuery,
	useRunReportQuery: () => reportQuery,
	isRunNotFound: () => false,
	useCollectionsQuery: () => ({ data: [{ id: "col_1", name: "Checkout" }] }),
}));

vi.mock("./LoadTestDetail", () => ({ default: () => null }));
vi.mock("./DesignRunView", () => ({ default: () => null }));
vi.mock("./ScenarioRunView", () => ({ default: () => null }));

function run(overrides: Partial<Run>): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: START,
		endTime: START + 1000,
		configSnapshot: {
			url: `https://api.example.test/orders?token=${SENTINEL}`,
			method: "POST",
			requestName: "Create order",
			headers: { Authorization: `Bearer ${SENTINEL}` },
			auth: { mode: "bearer", bearer: { token: SENTINEL } },
			variables: { apiKey: SENTINEL },
		},
		...overrides,
	} as Run;
}

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run_1" }],
		activeTabId: "t1",
	});
});

async function copyForAgent(loaded: Run): Promise<string> {
	runQuery.data = loaded;
	render(<HistoryDetail />);
	fireEvent.click(screen.getByRole("button", { name: "Copy for agent" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	const copied = writeText.mock.calls[0][0] as string;
	expect(copied).not.toContain(SENTINEL);
	return copied;
}

describe("Copy for agent in the run header", () => {
	it.each([
		[
			"design",
			run({ type: "design" }),
			`Vayu run "Create order" (run_1) - design run, POST /orders, ${AT}, completed`,
		],
		[
			"load",
			run({ type: "load" }),
			`Vayu run "Create order" (run_1) - load test, POST /orders, ${AT}, completed`,
		],
		[
			"scenario",
			run({ type: "scenario", configSnapshot: { scenario: { collectionId: "col_1" } } }),
			`Vayu run "Checkout" (run_1) - collection run, collection "Checkout", ${AT}, completed`,
		],
	])("copies a %s run's line from its snapshot", async (_type, loaded, line) => {
		expect(await copyForAgent(loaded)).toBe(line);
	});

	it("says what it copied", async () => {
		await copyForAgent(run({}));

		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});
});
