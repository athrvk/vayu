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
 * `useImportMcpApplyMutation` (#3994): one engine call, and the tree refreshed only when it
 * landed. A refused apply (a 409 for a stale row) wrote nothing, so refetching after it would
 * show the same rows again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useImportMcpApplyMutation } from "./import-mcp";
import { queryKeys } from "./keys";
import type { ImportMcpApplyRequest } from "@/types";

const importMcpApply = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { importMcpApply: (...a: unknown[]) => importMcpApply(...a) },
}));

const PAYLOAD: ImportMcpApplyRequest = {
	url: "https://mcp.example.com/mcp",
	collectionId: "col_1",
	select: { added: [], changed: ["req_1"], removed: [] },
};

function mutation() {
	// The shared client's mutation default is one retry; the hook must not lean on it.
	const client = new QueryClient({ defaultOptions: { mutations: { retry: 1 } } });
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { ...renderHook(() => useImportMcpApplyMutation(), { wrapper }), invalidate };
}

function invalidatedKeys(invalidate: { mock: { calls: unknown[][] } }): string[] {
	return invalidate.mock.calls.map(([arg]) =>
		JSON.stringify((arg as { queryKey: unknown }).queryKey)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("useImportMcpApplyMutation", () => {
	it("sends the payload as given and refreshes the collections and every request list", async () => {
		const answer = { collectionId: "col_1", created: [], updated: ["req_1"], deleted: [] };
		importMcpApply.mockResolvedValue(answer);
		const { result, invalidate } = mutation();

		await expect(result.current.mutateAsync(PAYLOAD)).resolves.toBe(answer);

		expect(importMcpApply).toHaveBeenCalledWith(PAYLOAD);
		const keys = invalidatedKeys(invalidate);
		expect(keys).toContain(JSON.stringify(queryKeys.collections.all));
		expect(keys).toContain(JSON.stringify(queryKeys.requests.all));
		expect(keys).toContain(JSON.stringify(queryKeys.prefetch.allRequests()));
	});

	it("refreshes nothing when the apply is refused, and does not send it twice", async () => {
		importMcpApply.mockRejectedValue(new Error("req_1 is no longer a changed entry"));
		const { result, invalidate } = mutation();

		await expect(result.current.mutateAsync(PAYLOAD)).rejects.toThrow(/no longer/);
		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(importMcpApply).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});
});
