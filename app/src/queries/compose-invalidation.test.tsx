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
 * The renderer's own environment, globals and collection PUTs drop every cached
 * composition, as the identical MCP writes do (#1877).
 *
 * The Code section's compose query is `staleTime: Infinity`, so a write the
 * renderer made itself reaches the snippet only through an invalidation. The
 * request PUT's narrower, per-request form is asserted beside the other
 * request-update cases in `request-update-invalidation.test.tsx`.
 *
 * "Invalidated" is the assertion, not "absent" (same shape as
 * `request-update-invalidation.test.tsx`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { invalidateCompositions } from "./compose-invalidation";
import { useUpdateCollectionMutation } from "./collections";
import { useUpdateEnvironmentMutation } from "./environments";
import { useUpdateGlobalsMutation } from "./globals";
import { queryKeys } from "./keys";

const updateCollection = vi.fn();
const updateEnvironment = vi.fn();
const updateGlobals = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		updateCollection: (...a: unknown[]) => updateCollection(...a),
		updateEnvironment: (...a: unknown[]) => updateEnvironment(...a),
		updateGlobals: (...a: unknown[]) => updateGlobals(...a),
	},
}));

const first = queryKeys.compose.forRequest("req_1", "env_1");
const second = queryKeys.compose.forRequest("req_2", "env_1");

function makeClient() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	client.setQueryData(first, {});
	client.setQueryData(second, {});
	return client;
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function expectBothInvalidated(client: QueryClient) {
	expect(client.getQueryState(first)?.isInvalidated).toBe(true);
	expect(client.getQueryState(second)?.isInvalidated).toBe(true);
}

beforeEach(() => vi.clearAllMocks());

describe("a renderer PUT drops every cached composition (#1877)", () => {
	it("on an environment update", async () => {
		updateEnvironment.mockResolvedValue({ id: "env_1", name: "Env", variables: {} });
		const client = makeClient();

		const { result } = renderHook(() => useUpdateEnvironmentMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "env_1", name: "Env" });

		expectBothInvalidated(client);
	});

	it("on a globals update", async () => {
		updateGlobals.mockResolvedValue({ variables: {} });
		const client = makeClient();

		const { result } = renderHook(() => useUpdateGlobalsMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ variables: {} });

		expectBothInvalidated(client);
	});

	it("on a collection update", async () => {
		updateCollection.mockResolvedValue({ id: "col_a", name: "A", order: 0 });
		const client = makeClient();

		const { result } = renderHook(() => useUpdateCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "col_a", name: "A" });

		expectBothInvalidated(client);
	});
});

describe("invalidateCompositions", () => {
	it("narrows to one request's compositions when given its id", () => {
		const client = makeClient();

		invalidateCompositions(client, "req_1");

		expect(client.getQueryState(first)?.isInvalidated).toBe(true);
		expect(client.getQueryState(second)?.isInvalidated).toBe(false);
	});

	it("takes every composition when no request is named", () => {
		const client = makeClient();

		invalidateCompositions(client);

		expectBothInvalidated(client);
	});
});
