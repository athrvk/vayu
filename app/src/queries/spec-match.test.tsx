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
 * The Spec tab's preview asks the engine the question the bind answers (issue
 * #3030).
 *
 * The bind derives a document's server base paths itself and matches
 * `https://h/v1/pets` to `/pets` with them; the preview only sees what it sends.
 * What these cases hold is the wiring: the base paths `describe` answered ride
 * to `POST /specs/match`, and they are part of the cache key - the answer is
 * cached forever, so a key without them would serve one document's pairing for
 * another that differs only in its servers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RequestSummary, SpecOperation } from "@/types";
import { useSpecMatchQuery } from "./specs";

const matchSpecOperations = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { matchSpecOperations: (...a: unknown[]) => matchSpecOperations(...a) },
}));

const OPERATIONS: SpecOperation[] = [{ operationId: "listPets", method: "GET", path: "/pets" }];
const REQUESTS = [
	{ id: "r1", method: "GET", url: "https://h/v1/pets" },
] as unknown as RequestSummary[];

interface Inputs {
	basePaths: string[] | null;
}

function render(initial: Inputs) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(
		({ basePaths }: Inputs) => useSpecMatchQuery("col_1", REQUESTS, OPERATIONS, basePaths),
		{ wrapper, initialProps: initial }
	);
}

beforeEach(() => {
	matchSpecOperations.mockReset();
	matchSpecOperations.mockResolvedValue({
		matched: [],
		unmatchedRequests: [],
		unmatchedOperations: [],
	});
});

describe("useSpecMatchQuery base paths", () => {
	it("sends the base paths describe answered with the operations", async () => {
		const { result } = render({ basePaths: ["/v1"] });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(matchSpecOperations).toHaveBeenCalledTimes(1);
		expect(matchSpecOperations).toHaveBeenCalledWith({
			collectionId: "col_1",
			operations: OPERATIONS,
			basePaths: ["/v1"],
		});
	});

	it("asks again when the base paths change, and not when they do not", async () => {
		const { result, rerender } = render({ basePaths: ["/v1"] });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		// An equal list in a new array is the same question: the key is a
		// fingerprint of the contents, so a re-render with a fresh array of the
		// same paths must not refetch.
		rerender({ basePaths: ["/v1"] });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(matchSpecOperations).toHaveBeenCalledTimes(1);

		rerender({ basePaths: ["/v1", "/v2"] });
		await waitFor(() => expect(matchSpecOperations).toHaveBeenCalledTimes(2));
		expect(matchSpecOperations).toHaveBeenLastCalledWith({
			collectionId: "col_1",
			operations: OPERATIONS,
			basePaths: ["/v1", "/v2"],
		});
	});
});
