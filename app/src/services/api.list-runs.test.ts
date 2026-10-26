/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The URL `listRuns` sends, asserted on the wire (#2978): a first page keeps its
 * `offset=0`, and a cursor page carries `before` with no offset beside it,
 * because the engine answers `before` plus a non-zero offset with a 400.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: { get: vi.fn() },
}));

const get = vi.mocked(httpClient.get);

beforeEach(() => {
	vi.clearAllMocks();
	get.mockResolvedValue({} as never);
});

describe("listRuns", () => {
	it("sends the first page with offset=0 and no cursor", async () => {
		await apiService.listRuns();

		expect(get).toHaveBeenCalledWith("/runs?limit=50&offset=0");
	});

	it("sends a cursor page with `before` and no offset", async () => {
		await apiService.listRuns({ before: "1234560001:run_1234560001" });

		expect(get).toHaveBeenCalledWith("/runs?limit=50&before=1234560001%3Arun_1234560001");
	});

	it("keeps an explicit offset beside a cursor so the engine can refuse the pair", async () => {
		await apiService.listRuns({ before: "7:run_7", offset: 50 });

		expect(get).toHaveBeenCalledWith("/runs?limit=50&offset=50&before=7%3Arun_7");
	});

	it("sends an explicit offset without a cursor", async () => {
		await apiService.listRuns({ offset: 50 });

		expect(get).toHaveBeenCalledWith("/runs?limit=50&offset=50");
	});
});
