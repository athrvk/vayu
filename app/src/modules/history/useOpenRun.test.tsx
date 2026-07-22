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
 * Where a click in the history list lands.
 *
 * The rule this pins is that a design run is not a document - it is a past
 * state of a request the user still has. Opening it in a read-only viewer of
 * its own meant the response you were looking at and the request that produced
 * it lived in two different tabs, and every fix to the response pane had to be
 * made twice. So a design run opens the builder, and the run tab is left for
 * the two shapes that genuinely have no builder: load tests, and design runs
 * whose request is gone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useOpenRun } from "./useOpenRun";
import { useResponseStore, useTabsStore } from "@/stores";
import type { Run, RunReport } from "@/types";

const getRunReport = vi.fn();
const listCollections = vi.fn();
const listRequests = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		getRunReport: (...args: unknown[]) => getRunReport(...args),
		listCollections: (...args: unknown[]) => listCollections(...args),
		listRequests: (...args: unknown[]) => listRequests(...args),
	},
}));

const REPORT: RunReport = {
	metadata: {
		runId: "run-1",
		runType: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
	},
	summary: {
		totalRequests: 1,
		successfulRequests: 1,
		failedRequests: 0,
		errorRate: 0,
		totalDurationSeconds: 0.3,
		avgRps: 3,
	},
	latency: { min: 254, max: 254, avg: 254, p50: 254, p90: 254, p95: 254, p99: 254 },
	statusCodes: { "200": 1 },
	errors: { total: 0, withDetails: 0, types: {} },
	results: [
		{
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 254,
			trace: {
				request: { method: "GET", url: "https://api.example.test/users", headers: {} },
				response: { headers: {}, body: '{"ok":true}' },
			},
		},
	],
};

function run(overrides: Partial<Run> = {}): Run {
	return {
		id: "run-1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
		requestId: "req-1",
		...overrides,
	};
}

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	vi.clearAllMocks();
	getRunReport.mockResolvedValue(REPORT);
	listCollections.mockResolvedValue([{ id: "col-1", name: "C", parentId: undefined }]);
	listRequests.mockResolvedValue([{ id: "req-1", name: "Users", collectionId: "col-1" }]);
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useResponseStore.getState().clearAll();
});

async function open(r: Run) {
	const { result } = renderHook(() => useOpenRun(), { wrapper });
	await act(async () => {
		await result.current.openRun(r);
	});
	return result;
}

describe("opening a design run", () => {
	it("opens the request builder, not a second viewer for the same row", async () => {
		await open(run());

		const tabs = useTabsStore.getState().openTabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ type: "request", entityId: "req-1" });
	});

	it("injects the stored response so the builder's pane shows this run", async () => {
		await open(run());

		const stored = useResponseStore.getState().getResponse("req-1");
		expect(stored?.body).toBe('{"ok":true}');
		// Without this the pane could not tell the user the response predates
		// whatever the request editor beside it currently says.
		expect(stored?.restoredFrom?.runId).toBe("run-1");
	});

	it("writes the response before opening the tab, which is what makes it visible", async () => {
		// The provider reads the store when it mounts. Opening first would mount
		// it against an empty store and the response would never appear.
		const order: string[] = [];
		const unsubResponse = useResponseStore.subscribe(() => order.push("response"));
		const unsubTabs = useTabsStore.subscribe(() => order.push("tab"));

		await open(run());
		unsubResponse();
		unsubTabs();

		expect(order.indexOf("response")).toBeLessThan(order.indexOf("tab"));
	});
});

describe("a design run with no builder to open", () => {
	it("falls back to the run tab when the run recorded no request id", async () => {
		await open(run({ requestId: null }));

		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run-1",
		});
		expect(getRunReport).toHaveBeenCalled();
	});

	it("falls back to the run tab when the request has since been deleted", async () => {
		// `delete_request` does not cascade to runs, so a live `requestId` is not
		// proof the request still exists - only the lookup is.
		listRequests.mockResolvedValue([]);

		await open(run());

		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run-1",
		});
	});

	it("falls back to the run tab when the report cannot be fetched", async () => {
		// The run tab refetches and has its own error pane with a retry.
		getRunReport.mockRejectedValue(new Error("engine unreachable"));

		await open(run());

		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "run" });
	});
});

describe("a load run", () => {
	it("opens its report directly, with no lookups at all", async () => {
		await open(run({ id: "run-2", type: "load", requestId: "req-1" }));

		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run-2",
		});
		expect(getRunReport).not.toHaveBeenCalled();
	});
});

describe("while the click resolves", () => {
	it("names the run being opened, so the row can show progress", async () => {
		let release: (report: RunReport) => void = () => {};
		getRunReport.mockReturnValue(
			new Promise<RunReport>((resolve) => {
				release = resolve;
			})
		);

		const { result } = renderHook(() => useOpenRun(), { wrapper });
		act(() => {
			void result.current.openRun(run());
		});

		await waitFor(() => expect(result.current.openingRunId).toBe("run-1"));

		await act(async () => {
			release(REPORT);
		});
		await waitFor(() => expect(result.current.openingRunId).toBeNull());
	});
});
