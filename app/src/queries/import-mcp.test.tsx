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
 * `useImportMcpApplyMutation` (#3994): one engine call, and the tree refreshed only when it
 * landed. A refused apply (a 409 for a stale row) wrote nothing, so refetching after it would
 * show the same rows again. An OAuth entry's token is fetched inside the mutation (#3983).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useImportMcpApplyMutation } from "./import-mcp";
import { queryKeys } from "./keys";
import type { ImportMcpApplyRequest, OAuth2Config } from "@/types";

const importMcpApply = vi.fn();
const fetchOAuth2Token = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		importMcpApply: (...a: unknown[]) => importMcpApply(...a),
		fetchOAuth2Token: (...a: unknown[]) => fetchOAuth2Token(...a),
	},
}));

const PAYLOAD: ImportMcpApplyRequest = {
	url: "https://mcp.example.com/mcp",
	collectionId: "col_1",
	select: { added: [], changed: ["req_1"], removed: [], renamed: [] },
};

function mutation() {
	// The shared client's mutation default is one retry; the hook must not lean on it.
	const client = new QueryClient({ defaultOptions: { mutations: { retry: 1 } } });
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { ...renderHook(() => useImportMcpApplyMutation(), { wrapper }), invalidate };
}

function invalidatedKeys(invalidate: { mock: { calls: unknown[][] } }): string[] {
	return invalidate.mock.calls.map(([arg]) =>
		JSON.stringify((arg as { queryKey: unknown }).queryKey)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("useImportMcpApplyMutation", () => {
	it("sends the payload as given and refreshes the collections and every request list", async () => {
		const answer = { collectionId: "col_1", created: [], updated: ["req_1"], deleted: [] };
		importMcpApply.mockResolvedValue(answer);
		const { result, invalidate } = mutation();

		await expect(result.current.mutateAsync({ payload: PAYLOAD })).resolves.toBe(answer);

		expect(importMcpApply).toHaveBeenCalledWith(PAYLOAD);
		expect(fetchOAuth2Token).not.toHaveBeenCalled();
		const keys = invalidatedKeys(invalidate);
		expect(keys).toContain(JSON.stringify(queryKeys.collections.all));
		expect(keys).toContain(JSON.stringify(queryKeys.requests.all));
		expect(keys).toContain(JSON.stringify(queryKeys.prefetch.allRequests()));
	});

	it("refreshes nothing when the apply is refused, and does not send it twice", async () => {
		importMcpApply.mockRejectedValue(new Error("req_1 is no longer a changed entry"));
		const { result, invalidate } = mutation();

		await expect(result.current.mutateAsync({ payload: PAYLOAD })).rejects.toThrow(/no longer/);
		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(importMcpApply).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	describe("for an OAuth connect's entry", () => {
		const OAUTH: OAuth2Config = {
			grantType: "authorization_code",
			discoverUrl: "https://mcp.example.com/mcp",
			accessTokenUrl: "https://auth.example.com/token",
			clientId: "registered-client",
		};

		it("sends the token the engine holds for the config now, as the bearer auth", async () => {
			fetchOAuth2Token.mockResolvedValue({ accessToken: "fresh-token" });
			importMcpApply.mockResolvedValue({
				collectionId: "col_1",
				created: [],
				updated: [],
				deleted: [],
			});
			const { result } = mutation();

			await result.current.mutateAsync({ payload: PAYLOAD, oauth: OAUTH });

			expect(fetchOAuth2Token).toHaveBeenCalledWith({ config: OAUTH });
			expect(importMcpApply).toHaveBeenCalledWith({
				...PAYLOAD,
				auth: { mode: "bearer", token: "fresh-token" },
			});
		});

		it("sends nothing when the token cannot be had", async () => {
			fetchOAuth2Token.mockRejectedValue(new Error("OAuth 2.0 authorization required"));
			const { result } = mutation();

			await expect(
				result.current.mutateAsync({ payload: PAYLOAD, oauth: OAUTH })
			).rejects.toThrow(/authorization required/);

			expect(importMcpApply).not.toHaveBeenCalled();
		});
	});
});
