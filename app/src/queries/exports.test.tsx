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
 * The run report export is a click, not a cached read: each call asks the
 * engine again, and nothing lands in the query cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useRunReportExport } from "./exports";
import { apiService } from "@/services/api";

vi.mock("@/services/api", () => ({
	apiService: { exportRunReport: vi.fn() },
}));

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client }, children);
}

const envelope = {
	text: "{}",
	fileName: "Orders 2026-10-05 0810.run.json",
	mimeType: "application/json",
	notes: { urlCredentialsOmitted: 0 },
};

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient();
	vi.mocked(apiService.exportRunReport).mockResolvedValue(envelope);
});

describe("useRunReportExport", () => {
	it("asks the engine on every call and caches nothing", async () => {
		const { result } = renderHook(() => useRunReportExport(), { wrapper });

		await act(async () => {
			await expect(result.current.mutateAsync({ runId: "run_1" })).resolves.toEqual(envelope);
			await result.current.mutateAsync({ runId: "run_1" });
		});

		expect(apiService.exportRunReport).toHaveBeenCalledTimes(2);
		expect(apiService.exportRunReport).toHaveBeenCalledWith({ runId: "run_1" });
		expect(client.getQueryCache().getAll()).toEqual([]);
	});

	it("surfaces the engine's refusal rather than retrying it", async () => {
		vi.mocked(apiService.exportRunReport).mockRejectedValue(new Error("Run is still running"));
		const { result } = renderHook(() => useRunReportExport(), { wrapper });

		await act(async () => {
			await expect(result.current.mutateAsync({ runId: "run_live" })).rejects.toThrow(
				"Run is still running"
			);
		});
		expect(apiService.exportRunReport).toHaveBeenCalledTimes(1);
	});
});
