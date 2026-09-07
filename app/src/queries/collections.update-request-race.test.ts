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
 * A foreign write's own refetch can land in the detail cache while a save this
 * client started is still in flight (issue #1436) - an MCP agent's
 * `update_request` racing the renderer's autosave. `useUpdateRequestMutation`'s
 * `onSuccess` used to overwrite the cache with its response unconditionally,
 * which meant the *older* of the two writes could win the cache purely by
 * finishing its round trip second - the request builder would then show a
 * value neither side just chose.
 *
 * `updatedAt` (a `toISOString()` string end to end, see
 * `request-transformer.ts`) is what breaks the tie: whichever row is newer
 * wins the cache, regardless of which mutation's response arrives last.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useUpdateRequestMutation } from "./collections";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";
import type { Request } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		updateRequest: vi.fn(),
	},
}));

const BASE: Request = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	description: "",
	method: "GET",
	url: "https://api.test/u",
	params: [],
	headers: [],
	body: { mode: "none" },
	bodyType: "none",
	auth: { mode: "none" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	stream: false,
	order: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("a save whose response is older than what a foreign write already cached", () => {
	it("does not overwrite the newer cached row", async () => {
		// The foreign write's own refetch already won the cache.
		const newer = {
			...BASE,
			url: "https://api.test/agent-write",
			updatedAt: "2026-01-01T00:00:05.000Z",
		};
		client.setQueryData(queryKeys.requests.detail(BASE.id), newer);

		// This mutation's response describes an *older* moment - it was in
		// flight before the foreign write landed, and only resolves after.
		const staleResponse = {
			...BASE,
			url: "https://api.test/my-edit",
			updatedAt: "2026-01-01T00:00:02.000Z",
		};
		vi.mocked(apiService.updateRequest).mockResolvedValue(staleResponse);

		const { result } = renderHook(() => useUpdateRequestMutation(), { wrapper });
		await result.current.mutateAsync({ id: BASE.id, url: "https://api.test/my-edit" });

		await waitFor(() => {
			expect(client.getQueryData<Request>(queryKeys.requests.detail(BASE.id))).toEqual(newer);
		});
	});

	it("still writes through when nothing raced it", async () => {
		client.setQueryData(queryKeys.requests.detail(BASE.id), BASE);
		const updated = {
			...BASE,
			url: "https://api.test/my-edit",
			updatedAt: "2026-01-01T00:00:02.000Z",
		};
		vi.mocked(apiService.updateRequest).mockResolvedValue(updated);

		const { result } = renderHook(() => useUpdateRequestMutation(), { wrapper });
		await result.current.mutateAsync({ id: BASE.id, url: "https://api.test/my-edit" });

		await waitFor(() => {
			expect(client.getQueryData<Request>(queryKeys.requests.detail(BASE.id))).toEqual(
				updated
			);
		});
	});

	it("writes through on a cold cache, where there is nothing to race", async () => {
		const updated = {
			...BASE,
			url: "https://api.test/my-edit",
			updatedAt: "2026-01-01T00:00:02.000Z",
		};
		vi.mocked(apiService.updateRequest).mockResolvedValue(updated);

		const { result } = renderHook(() => useUpdateRequestMutation(), { wrapper });
		await result.current.mutateAsync({ id: BASE.id, url: "https://api.test/my-edit" });

		await waitFor(() => {
			expect(client.getQueryData<Request>(queryKeys.requests.detail(BASE.id))).toEqual(
				updated
			);
		});
	});
});
