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
 * A bind is one call to one transactional route (issues #718, #862).
 *
 * This file used to hold the other half of the bind: the renderer stored the
 * document, moved the binding and then stamped each request itself, and the
 * cases here held it to writing identity in *both* directions - because a bind
 * that wrote only the matches left every non-matcher carrying the previous
 * document's operation, which coverage resolves by `operationId` first and so
 * reads as identity rather than as a gap.
 *
 * That invariant did not move here, it moved *down*: `POST /specs/bind` derives
 * the pairing from the bytes it stores and stamps both halves of it in one
 * transaction, and `spec_bind_route_test.cpp` is where re-binding is pinned
 * now. What is left for the renderer to get wrong is the wiring, and it is
 * exactly what these cases hold: one call, no pairing in it, and both cache
 * families refreshed however it ended.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useBindSpecMutation, type BindSpecInput } from "./specs";

const bindSpec = vi.fn();
const createSpec = vi.fn();
const updateCollection = vi.fn();
const updateRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		bindSpec: (...a: unknown[]) => bindSpec(...a),
		createSpec: (...a: unknown[]) => createSpec(...a),
		updateCollection: (...a: unknown[]) => updateCollection(...a),
		updateRequest: (...a: unknown[]) => updateRequest(...a),
	},
}));

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function bind() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(client, "invalidateQueries");
	return {
		...renderHook(() => useBindSpecMutation(), { wrapper: wrapper(client) }),
		invalidate,
	};
}

const input = (over: Partial<BindSpecInput> = {}): BindSpecInput => ({
	collectionId: "col_1",
	content: "openapi: 3.0.0",
	sourceUrl: null,
	...over,
});

/** Which query families a run of the mutation asked to be refetched. */
function invalidatedKeys(invalidate: { mock: { calls: unknown[][] } }): string[] {
	return invalidate.mock.calls.map(([arg]) =>
		JSON.stringify((arg as { queryKey: unknown }).queryKey)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	bindSpec.mockResolvedValue({
		specId: "spec_2",
		specHash: "h2",
		syncedAt: 5,
		stamped: 1,
		cleared: 1,
		unmatchedRequests: [],
		unmatchedOperations: [],
	});
});

describe("useBindSpecMutation", () => {
	it("binds through the one route, not a sequence of writes", async () => {
		const { result } = bind();

		const outcome = await result.current.mutateAsync(
			input({ sourceUrl: "https://example.com/openapi.yaml" })
		);

		expect(bindSpec).toHaveBeenCalledTimes(1);
		expect(bindSpec).toHaveBeenCalledWith({
			collectionId: "col_1",
			spec: { content: "openapi: 3.0.0", sourceUrl: "https://example.com/openapi.yaml" },
		});
		// The three writes this replaced. Any of them reappearing here is a bind
		// that can land in halves again.
		expect(createSpec).not.toHaveBeenCalled();
		expect(updateCollection).not.toHaveBeenCalled();
		expect(updateRequest).not.toHaveBeenCalled();
		expect(outcome.cleared).toBe(1);
	});

	it("sends the document and the collection, and no pairing", async () => {
		const { result } = bind();

		await result.current.mutateAsync(input());

		// The keys are asserted exhaustively on purpose: a `stamps` or a `clear`
		// list creeping back in would be the renderer deciding identity again,
		// which is the second opinion the engine-side reader exists to end.
		const [payload] = bindSpec.mock.calls[0] as [Record<string, unknown>];
		expect(Object.keys(payload).sort()).toEqual(["collectionId", "spec"]);
		expect(Object.keys(payload.spec as object)).toEqual(["content"]);
	});

	it("refreshes the collection and request families however the bind ended", async () => {
		const failed = bind();
		bindSpec.mockRejectedValueOnce(new Error("boom"));

		await expect(failed.result.current.mutateAsync(input())).rejects.toThrow("boom");

		// Settled rather than success: the counts the Spec tab shows are read off
		// the request rows, and a bind that failed leaves them as they were - the
		// tab only reports that by reading them again.
		expect(invalidatedKeys(failed.invalidate)).toEqual(['["collections"]', '["requests"]']);

		const ok = bind();
		await ok.result.current.mutateAsync(input());
		expect(invalidatedKeys(ok.invalidate)).toEqual(['["collections"]', '["requests"]']);
	});
});
