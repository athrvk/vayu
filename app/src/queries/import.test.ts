/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
	apiService: {
		applyImport: vi.fn(async () => ({ idMap: { c1: "col_1" } })),
		getGlobals: vi.fn(async () => ({ id: "globals", variables: {}, updatedAt: "0" })),
		updateGlobals: vi.fn(async (variables) => ({ id: "globals", variables, updatedAt: "1" })),
	},
}));

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { apiService } from "@/services/api";
import { createImportApi, useImportMutation } from "./import";
import { queryKeys } from "./keys";
import type { ImportResult } from "@/services/importers/types";

describe("createImportApi", () => {
	beforeEach(() => vi.clearAllMocks());
	it("delegates the one bulk call to apiService", async () => {
		const api = createImportApi();
		const payload = {
			collections: [{ tempId: "c1", parentTempId: null, name: "c" }],
			requests: [],
			environments: [],
		};
		await expect(api.applyImport(payload)).resolves.toEqual({ idMap: { c1: "col_1" } });
		expect(apiService.applyImport).toHaveBeenCalledWith(payload);
	});

	// Globals are not part of the bulk payload - they are an engine singleton, so
	// they stay their own read/write pair on the ImportApi.
	it("delegates the globals read and write to apiService", async () => {
		const api = createImportApi();
		await api.getGlobals();
		await api.updateGlobals({ a: { value: "1", enabled: true } });
		expect(apiService.getGlobals).toHaveBeenCalled();
		expect(apiService.updateGlobals).toHaveBeenCalledWith({ a: { value: "1", enabled: true } });
	});
});

describe("useImportMutation", () => {
	beforeEach(() => vi.clearAllMocks());

	/**
	 * A globals import writes the singleton on the engine. Without an invalidation
	 * the imported variables sit there unread until the next reload - the
	 * "written but never read" shape CLAUDE.md warns about.
	 */
	it("invalidates the globals cache after an import", async () => {
		const qc = new QueryClient();
		const spy = vi.spyOn(qc, "invalidateQueries");
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: qc }, children);

		const { result } = renderHook(() => useImportMutation(), { wrapper });

		const importResult: ImportResult = {
			collections: [],
			environments: [],
			globals: { token: { value: "t", enabled: true } },
			meta: {
				format: "Postman Globals",
				requestCount: 0,
				folderCount: 0,
				environmentCount: 0,
				globalCount: 1,
				skipped: [],
				nonExecutableAuth: 0,
			},
		};
		await result.current.mutateAsync({
			result: importResult,
			opts: { importEnvironments: true, importScripts: true },
		});

		await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.globals.all }));
		expect(apiService.updateGlobals).toHaveBeenCalledWith({
			token: { value: "t", enabled: true },
		});
	});
});
