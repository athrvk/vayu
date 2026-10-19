/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The allowed-folder calls. The list is a plain engine read, answered as a
 * bare array like `GET /client-certificates`; both writes need the grant
 * secret only the main process holds (#2356), so they cross the Electron
 * bridge and never reach the engine from here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiService } from "./api";
import { ApiError, EngineUnreachableError, httpClient } from "./http-client";

vi.mock("./http-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./http-client")>()),
	httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(httpClient.get);

function stubBridge() {
	const bridge = { allowFolder: vi.fn(), removeAllowedFolder: vi.fn() };
	vi.stubGlobal("window", { electronAPI: bridge });
	return bridge;
}

describe("file-roots API", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.unstubAllGlobals());

	it("reads the bare array GET /file-roots answers", async () => {
		const rows = [{ id: "r1", path: "/data", createdAt: 1 }];
		get.mockResolvedValue(rows as never);

		await expect(apiService.getFileRoots()).resolves.toEqual(rows);
		expect(get).toHaveBeenCalledWith("/file-roots");
	});

	it("allows a folder through the bridge, passing where the picker opens", async () => {
		const bridge = stubBridge();
		const reply = {
			outcome: "done",
			path: "/data",
			value: { id: "r1", path: "/data", createdAt: 1 },
		};
		bridge.allowFolder.mockResolvedValue(reply);

		await expect(
			apiService.allowChosenFolder({ title: "Allow a folder", defaultPath: "/data" })
		).resolves.toEqual(reply);
		expect(bridge.allowFolder).toHaveBeenCalledWith({
			title: "Allow a folder",
			defaultPath: "/data",
		});
		expect(vi.mocked(httpClient.post)).not.toHaveBeenCalled();
	});

	it("removes a folder through the bridge, by id", async () => {
		const bridge = stubBridge();
		bridge.removeAllowedFolder.mockResolvedValue({ outcome: "done", value: null });

		await apiService.deleteFileRoot("r1");

		expect(bridge.removeAllowedFolder).toHaveBeenCalledWith("r1");
		expect(vi.mocked(httpClient.delete)).not.toHaveBeenCalled();
	});

	it("rejects a refused remove with the engine's status, code and message", async () => {
		const bridge = stubBridge();
		bridge.removeAllowedFolder.mockResolvedValue({
			outcome: "refused",
			status: 404,
			code: "not_found",
			message: "No allowed folder r1",
		});

		const error = await apiService.deleteFileRoot("r1").catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			statusCode: 404,
			errorCode: "not_found",
			message: "No allowed folder r1",
		});
	});

	it("rejects an unanswered remove as the engine being unreachable", async () => {
		const bridge = stubBridge();
		bridge.removeAllowedFolder.mockResolvedValue({
			outcome: "unreachable",
			message: "fetch failed",
		});

		await expect(apiService.deleteFileRoot("r1")).rejects.toBeInstanceOf(
			EngineUnreachableError
		);
	});

	it("rejects both writes outside Electron, where nothing may make them", async () => {
		vi.stubGlobal("window", {});

		await expect(apiService.allowChosenFolder()).rejects.toThrow(/Vayu app/);
		await expect(apiService.deleteFileRoot("r1")).rejects.toThrow(/Vayu app/);
	});
});
