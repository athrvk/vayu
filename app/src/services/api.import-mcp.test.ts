/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `apiService.importMcp` (#3843): one buffered POST of what the dialog collected, with the
 * budget the engine's whole-import bound needs. The body is the route's own contract
 * (`docs/engine/api-reference/import.md#post-importmcp`), so the headers and the auth must reach
 * the wire exactly as given.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { IMPORT_MCP_TOTAL_TIMEOUT_MS } from "@/constants/import";
import type { ImportMcpApplyRequest, ImportMcpRequest } from "@/types/api";

vi.mock("./http-client", async () => {
	const actual = await vi.importActual<typeof import("./http-client")>("./http-client");
	return {
		ApiError: actual.ApiError,
		httpClient: { post: vi.fn(), stream: vi.fn() },
	};
});

const post = vi.mocked(httpClient.post);

const RESULT = { collections: [], environments: [], globals: {}, meta: { format: "MCP server" } };

const PAYLOAD: ImportMcpRequest = {
	url: "https://mcp.example.com/mcp",
	headers: [{ name: "X-Tenant", value: "acme" }],
	auth: { mode: "bearer", token: "secret-token" },
	include: { tools: true, resources: false, prompts: true },
};

beforeEach(() => {
	vi.clearAllMocks();
	post.mockResolvedValue(RESULT);
});

describe("apiService.importMcp", () => {
	it("posts the url, headers, auth and include to /import/mcp and returns the tree", async () => {
		const result = await apiService.importMcp(PAYLOAD);

		expect(result).toBe(RESULT);
		expect(post).toHaveBeenCalledTimes(1);
		const [path, body] = post.mock.calls[0] ?? [];
		expect(path).toBe(API_ENDPOINTS.IMPORT_MCP);
		expect(path).toBe("/import/mcp");
		expect(body).toEqual(PAYLOAD);
	});

	it("sends only what the caller gave, so an omitted include keeps the engine's default", async () => {
		await apiService.importMcp({ url: "https://mcp.example.com/mcp" });

		expect(post.mock.calls[0]?.[1]).toEqual({ url: "https://mcp.example.com/mcp" });
	});

	it("outlasts the engine's whole-import bound, so its own 502 arrives first", async () => {
		await apiService.importMcp(PAYLOAD);

		const options = post.mock.calls[0]?.[2] as { timeout: number };
		expect(options.timeout).toBeGreaterThan(IMPORT_MCP_TOTAL_TIMEOUT_MS);
	});

	it("passes the caller's signal through, and sends none when there is none", async () => {
		const controller = new AbortController();

		await apiService.importMcp(PAYLOAD, { signal: controller.signal });
		await apiService.importMcp(PAYLOAD);

		expect((post.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal).toBe(
			controller.signal
		);
		expect(post.mock.calls[1]?.[2]).not.toHaveProperty("signal");
	});

	it("lets the engine's refusal reach the caller untouched", async () => {
		const refusal = new Error("Invalid 'url': put credentials in auth or headers, not the URL");
		post.mockRejectedValue(refusal);

		await expect(apiService.importMcp(PAYLOAD)).rejects.toBe(refusal);
	});
});

describe("apiService.importMcpDiff (#3842)", () => {
	const DIFF = { matches: [] };

	beforeEach(() => {
		post.mockResolvedValue(DIFF);
	});

	it("posts the same body as importMcp to /import/mcp/diff and returns the answer", async () => {
		const result = await apiService.importMcpDiff(PAYLOAD);

		expect(result).toBe(DIFF);
		const [path, body] = post.mock.calls[0] ?? [];
		expect(path).toBe(API_ENDPOINTS.IMPORT_MCP_DIFF);
		expect(path).toBe("/import/mcp/diff");
		expect(body).toEqual(PAYLOAD);
	});

	it("waits as long as importMcp, since it reads the server the same way", async () => {
		await apiService.importMcpDiff(PAYLOAD);
		await apiService.importMcp(PAYLOAD);

		const [diff, imported] = post.mock.calls.map((call) => call[2] as { timeout: number });
		expect(diff.timeout).toBe(imported.timeout);
		expect(diff.timeout).toBeGreaterThan(IMPORT_MCP_TOTAL_TIMEOUT_MS);
	});

	it("passes the caller's signal through, and sends none when there is none", async () => {
		const controller = new AbortController();

		await apiService.importMcpDiff(PAYLOAD, { signal: controller.signal });
		await apiService.importMcpDiff(PAYLOAD);

		expect((post.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal).toBe(
			controller.signal
		);
		expect(post.mock.calls[1]?.[2]).not.toHaveProperty("signal");
	});

	it("lets the engine's refusal reach the caller untouched", async () => {
		const refusal = new Error("Server did not answer");
		post.mockRejectedValue(refusal);

		await expect(apiService.importMcpDiff(PAYLOAD)).rejects.toBe(refusal);
	});
});

describe("apiService.importMcpApply (#3994)", () => {
	const APPLY: ImportMcpApplyRequest = {
		...PAYLOAD,
		collectionId: "col_1",
		select: {
			added: [{ kind: "tool", key: "export" }],
			changed: ["req_1"],
			removed: ["req_9"],
			renamed: [{ requestId: "req_2", key: "find" }],
		},
	};
	const APPLIED = {
		collectionId: "col_1",
		created: [{ kind: "tool", key: "export", requestId: "req_3" }],
		updated: ["req_1"],
		deleted: ["req_9"],
	};

	beforeEach(() => {
		post.mockResolvedValue(APPLIED);
	});

	it("posts the server request, the collection and the selection to /import/mcp/apply", async () => {
		const result = await apiService.importMcpApply(APPLY);

		expect(result).toBe(APPLIED);
		const [path, body] = post.mock.calls[0] ?? [];
		expect(path).toBe(API_ENDPOINTS.IMPORT_MCP_APPLY);
		expect(path).toBe("/import/mcp/apply");
		expect(body).toEqual(APPLY);
	});

	it("waits as long as importMcp, since it reads the server the same way first", async () => {
		await apiService.importMcpApply(APPLY);
		await apiService.importMcp(PAYLOAD);

		const [apply, imported] = post.mock.calls.map((call) => call[2] as { timeout: number });
		expect(apply.timeout).toBe(imported.timeout);
		expect(apply.timeout).toBeGreaterThan(IMPORT_MCP_TOTAL_TIMEOUT_MS);
	});

	it("lets the engine's refusal reach the caller untouched", async () => {
		const stale = new Error("req_1 is no longer a changed entry; compare again");
		post.mockRejectedValue(stale);

		await expect(apiService.importMcpApply(APPLY)).rejects.toBe(stale);
	});
});
