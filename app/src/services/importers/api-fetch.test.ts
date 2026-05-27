import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/http-client", () => ({
	httpClient: { post: vi.fn() },
}));

import { httpClient } from "@/services/http-client";
import { apiService } from "@/services/api";

describe("apiService.importFetch", () => {
	beforeEach(() => vi.clearAllMocks());
	it("POSTs the url to /import/fetch and returns the content envelope", async () => {
		(httpClient.post as any).mockResolvedValue({
			content: "{}",
			contentType: "application/json",
		});
		const res = await apiService.importFetch("https://x/spec.json");
		expect(httpClient.post).toHaveBeenCalledWith("/import/fetch", {
			url: "https://x/spec.json",
		});
		expect(res).toEqual({ content: "{}", contentType: "application/json" });
	});
});
