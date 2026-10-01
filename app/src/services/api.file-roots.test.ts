/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The allowed-folder routes, at the payload level: the engine owns the id
 * (a create carrying one is a 400), answers `GET` with a bare array like
 * `GET /client-certificates`, and deletes by path id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(httpClient.get);
const post = vi.mocked(httpClient.post);
const del = vi.mocked(httpClient.delete);

describe("file-roots API", () => {
	beforeEach(() => vi.clearAllMocks());

	it("reads the bare array GET /file-roots answers", async () => {
		const rows = [{ id: "r1", path: "/data", createdAt: 1 }];
		get.mockResolvedValue(rows as never);

		await expect(apiService.getFileRoots()).resolves.toEqual(rows);
		expect(get).toHaveBeenCalledWith("/file-roots");
	});

	it("creates with the path alone, never an id", async () => {
		post.mockResolvedValue({ id: "r1", path: "/data", createdAt: 1 } as never);

		await apiService.createFileRoot({ path: "/data", id: "client" } as never);

		expect(post).toHaveBeenCalledWith("/file-roots", { path: "/data" });
	});

	it("deletes by id in the path", async () => {
		del.mockResolvedValue(undefined as never);
		await apiService.deleteFileRoot("r1");
		expect(del).toHaveBeenCalledWith("/file-roots/r1");
	});
});
