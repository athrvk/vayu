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
 * What deleting an example invalidates.
 *
 * A saved example's delete adds an entry to the Trash (#2971), so an open Trash
 * view has to refetch - the cross-boundary invalidation every other soft delete
 * makes. The panel tests replace `@/queries` or stub only `apiService`, and
 * neither reads this `onSuccess`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useDeleteRequestExampleMutation } from "./request-examples";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";

vi.mock("@/services/api", () => ({
	apiService: { deleteRequestExample: vi.fn() },
}));

let client: QueryClient;
let invalidated: string[];

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	invalidated = [];
	const real = client.invalidateQueries.bind(client);
	vi.spyOn(client, "invalidateQueries").mockImplementation((filters) => {
		invalidated.push(((filters?.queryKey ?? []) as string[]).join("/"));
		return real(filters);
	});
	vi.mocked(apiService.deleteRequestExample).mockReset().mockResolvedValue(undefined);
});

describe("useDeleteRequestExampleMutation", () => {
	it("refetches the request's examples and the Trash list", async () => {
		const { result } = renderHook(() => useDeleteRequestExampleMutation(), { wrapper });

		await result.current.mutateAsync({ requestId: "req_1", exampleId: "exa_1" });

		expect(apiService.deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_1");
		expect([...invalidated].sort()).toEqual(
			[queryKeys.requests.examples("req_1"), queryKeys.trash.all]
				.map((k) => k.join("/"))
				.sort()
		);
	});

	it("invalidates nothing when the engine refuses the delete", async () => {
		vi.mocked(apiService.deleteRequestExample).mockRejectedValue(
			new Error("Example not found")
		);
		const { result } = renderHook(() => useDeleteRequestExampleMutation(), { wrapper });

		await expect(
			result.current.mutateAsync({ requestId: "req_1", exampleId: "exa_1" })
		).rejects.toThrow("Example not found");

		expect(invalidated).toEqual([]);
	});
});
