import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
	apiService: {
		applyImport: vi.fn(async () => ({ idMap: { c1: "col_1" } })),
	},
}));

import { apiService } from "@/services/api";
import { createImportApi } from "./import";

describe("createImportApi", () => {
	beforeEach(() => vi.clearAllMocks());
	it("delegates the one bulk call to apiService", async () => {
		const api = createImportApi();
		const payload = {
			collections: [{ tempId: "c1", parentTempId: null, name: "c" }],
			requests: [],
			environments: [],
		};
		await expect(api.applyImport(payload)).resolves.toEqual({ idMap: { c1: "col_1" } });
		expect(apiService.applyImport).toHaveBeenCalledWith(payload);
	});
});
