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
import { QUERY_CACHE } from "@/config/cache";
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

/**
 * The hook's retry override is only meaningful against the *app's* defaults, so the
 * wrapper reproduces them instead of using a bare `new QueryClient()` (which defaults
 * mutations to no retry and would make the retry test vacuous).
 */
function appDefaultsClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { mutations: { retry: QUERY_CACHE.DEFAULT_MUTATION_RETRY } },
	});
}

const COLLECTION_ONLY: ImportResult = {
	collections: [
		{
			name: "Imported",
			description: "",
			variables: {},
			auth: { mode: "none" },
			preRequestScript: "",
			postRequestScript: "",
			children: [],
			requests: [],
		},
	],
	environments: [],
	globals: {},
	meta: {
		format: "Postman Collection v2.1",
		requestCount: 0,
		folderCount: 1,
		environmentCount: 0,
		globalCount: 0,
		skipped: [],
		nonExecutableAuth: 0,
	},
};

describe("useImportMutation", () => {
	// clearAllMocks wipes calls but keeps implementations, so the per-test
	// reject/resolve overrides below would leak into whatever runs after them.
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(apiService.applyImport).mockResolvedValue({ idMap: { c1: "col_1" } });
	});

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

	/**
	 * `POST /import/apply` is create-only and has no idempotency key, so a retry after a
	 * lost response (the tree committed, the 30s fetch timeout fired) is a second full
	 * copy of it - reported to the user as one clean import.
	 */
	it("never re-POSTs the bulk import when the apply call rejects", async () => {
		// Guard: with no retry in the defaults this test would pass while asserting nothing.
		expect(QUERY_CACHE.DEFAULT_MUTATION_RETRY).toBeGreaterThan(0);
		vi.mocked(apiService.applyImport).mockRejectedValue(new Error("Request timed out"));

		const qc = appDefaultsClient();
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: qc }, children);
		const { result } = renderHook(() => useImportMutation(), { wrapper });

		await expect(
			result.current.mutateAsync({
				result: COLLECTION_ONLY,
				opts: { importEnvironments: true, importScripts: true },
			})
		).rejects.toThrow("Request timed out");

		expect(apiService.applyImport).toHaveBeenCalledTimes(1);
	});

	/**
	 * The id-map check throws *after* the atomic apply committed the tree. Invalidating
	 * only in onSuccess left that tree invisible - `refetchOnWindowFocus` is off - until
	 * the user reloaded the app.
	 */
	it("invalidates the caches when the orchestrator throws after a committed apply", async () => {
		vi.mocked(apiService.applyImport).mockResolvedValue({ idMap: {} });

		const qc = appDefaultsClient();
		const spy = vi.spyOn(qc, "invalidateQueries");
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: qc }, children);
		const { result } = renderHook(() => useImportMutation(), { wrapper });

		await expect(
			result.current.mutateAsync({
				result: COLLECTION_ONLY,
				opts: { importEnvironments: true, importScripts: true },
			})
		).rejects.toThrow(/Import incomplete/);

		for (const queryKey of [
			queryKeys.collections.all,
			queryKeys.requests.all,
			queryKeys.environments.all,
			queryKeys.globals.all,
		]) {
			expect(spy).toHaveBeenCalledWith({ queryKey });
		}
	});
});
