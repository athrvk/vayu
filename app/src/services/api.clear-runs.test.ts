/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `clearRuns` is the one engine call behind Settings > Clear run history
 * (#2429). Assert the captured verb and path: a `DELETE /runs/:id` loop was the
 * old shape, and it deleted pinned baselines the engine's own pass keeps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const del = vi.mocked(httpClient.delete);

describe("apiService.clearRuns", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sends one DELETE to the collection path and returns the verdict", async () => {
		const verdict = { deleted: 1, keptPinned: 2, deletedIds: ["r1"] };
		del.mockResolvedValue(verdict as never);

		await expect(apiService.clearRuns()).resolves.toEqual(verdict);

		expect(del).toHaveBeenCalledTimes(1);
		expect(del).toHaveBeenCalledWith("/runs");
	});
});
