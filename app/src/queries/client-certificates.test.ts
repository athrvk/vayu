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
 * What deleting a client certificate invalidates.
 *
 * The delete is soft since #2973, so it adds an entry to the Trash: an open
 * Trash view has to refetch, the cross-boundary invalidation every other soft
 * delete makes. The card tests replace `@/queries` wholesale and neither reads
 * this `onSuccess`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useDeleteClientCertificateMutation } from "./client-certificates";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";

vi.mock("@/services/api", () => ({
	apiService: { deleteClientCertificate: vi.fn() },
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
	vi.mocked(apiService.deleteClientCertificate).mockReset().mockResolvedValue(undefined);
});

describe("useDeleteClientCertificateMutation", () => {
	it("refetches the registry and the Trash list", async () => {
		const { result } = renderHook(() => useDeleteClientCertificateMutation(), { wrapper });

		await result.current.mutateAsync("cert_1");

		expect(apiService.deleteClientCertificate).toHaveBeenCalledWith("cert_1");
		expect([...invalidated].sort()).toEqual(
			[queryKeys.clientCertificates.all, queryKeys.trash.all].map((k) => k.join("/")).sort()
		);
	});

	it("invalidates nothing when the engine refuses the delete", async () => {
		vi.mocked(apiService.deleteClientCertificate).mockRejectedValue(
			new Error("Client certificate not found")
		);
		const { result } = renderHook(() => useDeleteClientCertificateMutation(), { wrapper });

		await expect(result.current.mutateAsync("cert_1")).rejects.toThrow(
			"Client certificate not found"
		);

		expect(invalidated).toEqual([]);
	});
});
