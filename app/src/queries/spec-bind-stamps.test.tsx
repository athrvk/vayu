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
 * A bind writes identity in both directions (issue #718).
 *
 * `useBindSpecMutation` used to write only the matches, which is indistinguishable
 * from correct while a collection is bound once and never again. Re-binding to a
 * *different* document stamps whatever matches it and says nothing about the
 * rest, so a request that matched the old document kept the old document's
 * operation - and coverage resolves a stamp by `operationId` first, so such a
 * stamp does not go unread, it claims whichever operation of the new document
 * happens to share the id.
 *
 * The invariant these tests hold: after a bind, a request's `specOperation` is
 * the operation it matched in the bound document, or nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useBindSpecMutation, type BindSpecInput } from "./specs";

const createSpec = vi.fn();
const updateCollection = vi.fn();
const updateRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
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
	return renderHook(() => useBindSpecMutation(), { wrapper: wrapper(client) });
}

const input = (over: Partial<BindSpecInput> = {}): BindSpecInput => ({
	collectionId: "col_1",
	content: "{}",
	sourceUrl: null,
	stamps: [],
	clearStamps: [],
	...over,
});

/** Every `updateRequest` call, as `[id, specOperation]` pairs. */
function requestWrites(): [string, unknown][] {
	return updateRequest.mock.calls.map(([patch]) => [
		(patch as { id: string }).id,
		(patch as { specOperation: unknown }).specOperation,
	]);
}

beforeEach(() => {
	vi.clearAllMocks();
	createSpec.mockResolvedValue({ id: "spec_2", hash: "h2" });
	updateCollection.mockResolvedValue({});
	updateRequest.mockResolvedValue({});
});

describe("useBindSpecMutation", () => {
	it("clears the identity of a request the new document does not account for", async () => {
		const { result } = bind();

		await result.current.mutateAsync(
			input({
				stamps: [
					{
						requestId: "req_matched",
						specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
					},
				],
				clearStamps: ["req_stale"],
			})
		);

		// `null`, never an absent key: the engine reads absent as "keep", so a
		// patch that merely omits the field is a no-op that looks like a clear.
		expect(requestWrites()).toContainEqual(["req_stale", null]);
		expect(requestWrites()).toContainEqual([
			"req_matched",
			{ operationId: "listPets", method: "GET", path: "/pets" },
		]);
		expect(updateRequest).toHaveBeenCalledTimes(2);
	});

	it("writes nothing for a request named by neither list", async () => {
		const { result } = bind();

		await result.current.mutateAsync(input());

		// A collection whose requests all matched, or none did and none carried a
		// stamp: the bind is two writes and no third.
		expect(updateRequest).not.toHaveBeenCalled();
	});

	it("reports a failed clear apart from a failed stamp", async () => {
		updateRequest.mockImplementation(({ id }: { id: string }) =>
			id === "req_stale" ? Promise.reject(new Error("boom")) : Promise.resolve({})
		);
		const { result } = bind();

		const outcome = await result.current.mutateAsync(
			input({
				stamps: [
					{
						requestId: "req_matched",
						specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
					},
				],
				clearStamps: ["req_stale"],
			})
		);

		// The two failures leave different states and are named separately: an
		// unstamped request has no identity, a request whose clear failed still
		// claims one, and it is one of another document's.
		expect(outcome.failedClears).toEqual(["req_stale"]);
		expect(outcome.failedStamps).toEqual([]);
		expect(outcome.stamped).toBe(1);
	});

	it("keeps the binding when a clear fails, rather than rolling it back", async () => {
		updateRequest.mockRejectedValue(new Error("boom"));
		const { result } = bind();

		const outcome = await result.current.mutateAsync(input({ clearStamps: ["req_stale"] }));

		// Same rule the stamps have always followed: there is no transaction
		// spanning three routes, and the collection *is* bound.
		expect(updateCollection).toHaveBeenCalledWith({
			id: "col_1",
			openapi: expect.objectContaining({ specId: "spec_2", specHash: "h2" }),
		});
		expect(outcome.spec.id).toBe("spec_2");
		expect(outcome.failedClears).toEqual(["req_stale"]);
	});
});
