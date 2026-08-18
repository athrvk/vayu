import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/http-client", () => ({
	httpClient: { post: vi.fn() },
}));

import { httpClient } from "@/services/http-client";
import { apiService } from "@/services/api";

describe("apiService.importFetch", () => {
	beforeEach(() => vi.clearAllMocks());
	it("POSTs the url to /import/fetch and returns the content envelope", async () => {
		vi.mocked(httpClient.post).mockResolvedValue({
			content: "{}",
			contentType: "application/json",
		});
		const res = await apiService.importFetch("https://x/spec.json");
		expect(httpClient.post).toHaveBeenCalledWith(
			"/import/fetch",
			{ url: "https://x/spec.json" },
			// Proxied call: timeout derives from the engine's defaultTimeout
			// setting (engine max + grace when the config cache is cold)
			{ timeout: expect.any(Number) }
		);
		expect(res).toEqual({ content: "{}", contentType: "application/json" });
	});

	// The bound is the caller's to state (issue #784): the route proxies every
	// import format, so the engine has none to derive. A caller that knows it is
	// fetching a spec sends the live `maxSpecDocumentBytes`; one that does not
	// sends no key at all and gets the engine's transport ceiling - which is why
	// the field has to be *absent*, not a zero or a null the engine would have
	// to interpret.
	it("sends the caller's byte bound when it states one", async () => {
		vi.mocked(httpClient.post).mockResolvedValue({ content: "{}", contentType: "" });
		await apiService.importFetch("https://x/spec.json", 10 * 1024 * 1024);
		expect(httpClient.post).toHaveBeenCalledWith(
			"/import/fetch",
			{ url: "https://x/spec.json", maxBytes: 10 * 1024 * 1024 },
			{ timeout: expect.any(Number) }
		);
	});

	it("sends no maxBytes key at all when the caller states no bound", async () => {
		vi.mocked(httpClient.post).mockResolvedValue({ content: "{}", contentType: "" });
		await apiService.importFetch("https://x/collection.json");
		const body = vi.mocked(httpClient.post).mock.calls[0][1];
		expect(body).not.toHaveProperty("maxBytes");
	});
});
