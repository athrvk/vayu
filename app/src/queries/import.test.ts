import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
	apiService: {
		createCollection: vi.fn(async (d) => ({ id: d.id })),
		createRequest: vi.fn(async (d) => ({ id: d.id })),
		createEnvironment: vi.fn(async (d) => ({ id: d.id })),
		deleteCollection: vi.fn(async () => {}),
		deleteEnvironment: vi.fn(async () => {}),
	},
}));

import { apiService } from "@/services/api";
import { createImportApi } from "./import";

describe("createImportApi", () => {
	beforeEach(() => vi.clearAllMocks());
	it("delegates each method to apiService", async () => {
		const api = createImportApi();
		await api.createCollection({ id: "col_1", name: "c" } as any);
		await api.createRequest({
			id: "req_1",
			collectionId: "col_1",
			name: "r",
			method: "GET",
			url: "",
		} as any);
		await api.createEnvironment({ id: "env_1", name: "e", variables: {} } as any);
		await api.deleteCollection("col_1");
		await api.deleteEnvironment("env_1");
		expect(apiService.createCollection).toHaveBeenCalled();
		expect(apiService.createRequest).toHaveBeenCalled();
		expect(apiService.createEnvironment).toHaveBeenCalled();
		expect(apiService.deleteCollection).toHaveBeenCalledWith("col_1");
		expect(apiService.deleteEnvironment).toHaveBeenCalledWith("env_1");
	});
});
