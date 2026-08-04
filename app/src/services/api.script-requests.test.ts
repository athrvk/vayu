/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's opt-in to `pm.sendRequest` (issue #302).
 *
 * The engine denies script-issued requests unless the payload carries
 * `allowScriptRequests`, because Vayu's MCP target allowlist is checked in the
 * MCP server *before* the engine is called - a request sent from inside a
 * script never passes that gate. The renderer is the surface whose scripts the
 * user wrote, so it asks; the MCP server never does (asserted in
 * `electron/mcp/tools.test.ts`).
 *
 * Asserted on the captured body rather than on behaviour, for the same reason
 * `api.write-verbs.test.ts` is: nothing about a Send changes shape when this
 * regresses. The field would simply stop being sent and `pm.sendRequest` would
 * start throwing at runtime with every other test still green - so the payload
 * is the only layer that can catch it.
 *
 * Set inside the service rather than at each call site, so this also pins that
 * a caller does not have to know about it: the two callers below pass no such
 * field.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: {
		get: vi.fn(),
		post: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
	},
}));

const post = vi.mocked(httpClient.post);

describe("the renderer opts its own executions into pm.sendRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		post.mockResolvedValue({} as never);
	});

	it("sends allowScriptRequests on execute, without the caller passing it", async () => {
		await apiService.executeRequest({ method: "GET", url: "https://example.com" });

		expect(post).toHaveBeenCalledTimes(1);
		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({
			url: "https://example.com",
			allowScriptRequests: true,
		});
	});

	it("sends allowScriptRequests on a load run - one Tests script, one behaviour", async () => {
		await apiService.startLoadTest({ method: "GET", url: "https://example.com" } as never);

		expect(post).toHaveBeenCalledTimes(1);
		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({ allowScriptRequests: true });
	});

	it("does not disturb the fields the caller did send", async () => {
		await apiService.executeRequest({
			method: "POST",
			url: "https://example.com",
			headers: { "X-A": "1" },
			httpVersion: "http2",
		});

		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({
			method: "POST",
			headers: { "X-A": "1" },
			httpVersion: "http2",
			allowScriptRequests: true,
		});
	});
});
