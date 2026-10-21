/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two shapes of `GET /requests` (#2546), asserted on the wire: the tree's
 * list asks for `fields=summary` and reads a `RequestSummary` back, and the
 * whole-row list asks for nothing extra. Only the captured query string proves
 * the launch is the small answer - the summary and full calls return the same
 * rows, so nothing above this layer can tell them apart by their ids.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: { get: vi.fn() },
}));

const get = vi.mocked(httpClient.get);

const summaryRow = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get pet",
	method: "GET",
	url: "https://api.example.com/pets/1",
	order: 0,
	createdAt: 1_700_000_000_000,
	specOperation: null,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listRequestSummaries", () => {
	it("asks for the summary of every request", async () => {
		get.mockResolvedValue([summaryRow] as never);

		const rows = await apiService.listRequestSummaries();

		expect(get).toHaveBeenCalledWith("/requests", { fields: "summary" });
		expect(rows).toEqual([
			{
				id: "req_1",
				collectionId: "col_1",
				name: "Get pet",
				method: "GET",
				url: "https://api.example.com/pets/1",
				order: 0,
				createdAt: new Date(1_700_000_000_000).toISOString(),
			},
		]);
	});

	it("scopes the summary to one collection when asked", async () => {
		get.mockResolvedValue([] as never);

		await apiService.listRequestSummaries({ collectionId: "col_1" });

		expect(get).toHaveBeenCalledWith("/requests", {
			collectionId: "col_1",
			fields: "summary",
		});
	});
});

describe("listRequests", () => {
	it("asks for the whole rows, with no fields parameter", async () => {
		get.mockResolvedValue([] as never);

		await apiService.listRequests();
		await apiService.listRequests({ collectionId: "col_1" });

		expect(get.mock.calls).toEqual([
			["/requests", undefined],
			["/requests", { collectionId: "col_1" }],
		]);
	});
});
